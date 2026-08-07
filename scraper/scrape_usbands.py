#!/usr/bin/env python3
"""USBands discovery probe — --discover ONLY, no ingest yet.

Modeled on scrape_wgi.py's discover/harvest_candidates pattern: fetch
usbands.org's public score surfaces plus one hop of score/result/event-ish
links, harvest every GUID seen, and test each candidate against
CompetitionSuite's public bridge API (the platform DCI and WGI publish
through). Writes data/usbands_probe.json with the evidence — page bytes,
GUIDs, candidate links, and org_guid if a candidate returns seasons.
Never touches docs/.

The bridge may be unreachable from some networks (403 from sandboxes); the
probe detects that with a cheap sentinel, records it, and still writes the
usbands.org harvest evidence — so it is safe to run anywhere and is meant
to be run for real from GitHub Actions (wgi-ingest.yml discover mode).

    PYTHONPATH=scraper python3 scraper/scrape_usbands.py --discover
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from itertools import zip_longest
from urllib.parse import urljoin

from common import ROOT, fetch, log
import scrape_compsuite as cs

PROBE_OUT = ROOT / "data" / "usbands_probe.json"
GUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
HREF_RE = re.compile(r'href=["\']([^"\'#]+)["\']', re.I)
HINT = re.compile(r"score|result|event|recap|competitionsuite", re.I)
ASSET_RE = re.compile(r"\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|xml|pdf)(?:\?|$)", re.I)

MAX_HOP = 12          # one-hop pages fetched, tops
MAX_CANDIDATES = 15   # candidate GUIDs tested against the bridge, tops


def seed_pages() -> list[str]:
    """The advertised score surfaces plus the previous season's event listing —
    USBands renders 'Competition Results' tables only on past events, so the
    prior season is where score evidence actually lives."""
    return [
        "https://usbands.org/",
        "https://usbands.org/scores/",
        "https://usbands.org/events/",
        f"https://usbands.org/events/?year={datetime.now(timezone.utc).year - 1}",
    ]


# ---------------------------------------------------------------------------
# harvest
# ---------------------------------------------------------------------------

def _score_stats(html: str) -> dict:
    """Inline score-table evidence: usbands.org renders results itself in a
    scores tab (rank/band/score rows), no CompetitionSuite embed needed."""
    return {"score_tables": len(re.findall(r'scores-division__name', html)),
            "score_rows": html.count('class="scores-row"')}


def harvest_candidates() -> tuple[list[str], dict]:
    """All GUIDs seen on usbands.org score surfaces plus one hop of
    score/result/event-ish links — candidates to test against the bridge API."""
    pages = seed_pages()
    seen: list[str] = []
    evidence: dict = {}
    per_seed_links: list[list[str]] = []
    for url in pages:
        html = fetch(url) or ""
        links: list[str] = []
        for href in HREF_RE.findall(html):
            absu = urljoin(url, href)
            if absu.startswith("http") and HINT.search(absu) and not ASSET_RE.search(absu):
                if absu not in links:
                    links.append(absu)
        evidence[url] = {"bytes": len(html),
                         "guids": sorted(set(GUID_RE.findall(html))),
                         "links": links[:40], **_score_stats(html)}
        seen += evidence[url]["guids"]
        # event detail pages first — that's where the score tables render
        per_seed_links.append([u for u in links if "details.php" in u]
                              + [u for u in links if "details.php" not in u])
    hop: list[str] = []
    for tier in zip_longest(*per_seed_links):  # round-robin across seeds
        for u in tier:
            if u and u not in pages and u not in hop and len(hop) < MAX_HOP:
                hop.append(u)
    for url in hop:
        html = fetch(url) or ""
        evidence[url] = {"hop": 1, "bytes": len(html),
                         "guids": sorted(set(GUID_RE.findall(html))),
                         **_score_stats(html)}
        seen += evidence[url]["guids"]
    ordered = list(dict.fromkeys(seen))  # de-duped, first-seen order
    return ordered, evidence


# ---------------------------------------------------------------------------
# bridge testing
# ---------------------------------------------------------------------------

def bridge_reachable() -> bool:
    """Cheap sentinel: DCI's known org GUID against GetSeasons, one attempt.
    A blocked network (403 from this sandbox) fails fast here instead of
    stalling on retry backoff for every candidate."""
    txt = fetch(f"{cs.BRIDGE}/GetSeasons/jsonp?organization={cs.DCI_ORG}",
                force=True, retries=1, accept_json=True)
    return bool(txt)


def discover() -> int:
    candidates, evidence = harvest_candidates()
    report: dict = {
        "source": "usbands",
        "probed_at": datetime.now(timezone.utc).isoformat(),
        "org_guid": None,
        "candidates": candidates,
        "evidence": evidence,
    }
    forced = os.environ.get("USBANDS_ORG_GUID")
    if forced and forced not in candidates:
        candidates = [forced] + candidates
        report["candidates"] = candidates
        report["org_guid_via_env"] = forced
    if not bridge_reachable():
        report["bridge_reachable"] = False
        report["note"] = ("CompetitionSuite bridge unreachable from this network "
                          "(expected in some sandboxes) — re-run from GitHub Actions "
                          "to test the candidate GUIDs")
    else:
        report["bridge_reachable"] = True
        report["candidates_tested"] = candidates[:MAX_CANDIDATES]
        for guid in candidates[:MAX_CANDIDATES]:
            seasons = cs._bridge(f"GetSeasons/jsonp?organization={guid}") or []
            if seasons:
                report["org_guid"] = guid
                report["org_guid_via"] = "bridge-tested candidate"
                report["seasons"] = seasons
                break
    report["pages_with_inline_scores"] = sorted(
        u for u, p in evidence.items() if p.get("score_rows"))
    PROBE_OUT.parent.mkdir(parents=True, exist_ok=True)
    PROBE_OUT.write_text(json.dumps(report, indent=1, default=str))
    n_links = sum(len(p.get("links", [])) for p in evidence.values())
    n_score_rows = sum(p.get("score_rows", 0) for p in evidence.values())
    log(f"usbands discover: {len(candidates)} candidate guids, {n_links} score-ish links, "
        f"{n_score_rows} inline score rows on {len(report['pages_with_inline_scores'])} pages, "
        f"bridge_reachable={report.get('bridge_reachable')}, "
        f"org={report['org_guid'] or 'NOT FOUND'} -> {PROBE_OUT}")
    # success = we found a usable score surface: a bridge org OR usbands' own
    # inline score tables (evidence enough to design the real adapter on)
    return 0 if (report["org_guid"] or report["pages_with_inline_scores"]) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--discover", action="store_true",
                    help="probe usbands.org + bridge, write data/usbands_probe.json")
    args = ap.parse_args()
    if args.discover:
        return discover()
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
