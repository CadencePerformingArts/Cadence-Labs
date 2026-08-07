#!/usr/bin/env python3
"""Fallback score source: downbeatdesigns.com.

dci.org sits behind Cloudflare, which periodically serves a managed
challenge to cloud-runner IPs — when that happens, no client on the runner
can read new score pages (verified: curl and headless Chrome both get
"Just a moment..."). downbeatdesigns.com publishes the same DCI results and
is reachable from those IPs, so it backfills the gap.

This is strictly a *fill-in*: it only adds shows dci.org hasn't provided and
never overwrites an event that already has results (dci.org data carries the
judge-level recaps this site lacks). Each show is keyed by its canonical
dci.org URL — taken from the page's own "Full recap on DCI.org" link — so
when the challenge lifts and scrape_dci.py fetches the real page, it upgrades
the stub in place with no duplicate.

Verified against known-good dci.org data (DCI Central Texas 2026): all eight
World/Open Class placements and scores matched exactly.
"""
from __future__ import annotations

import html as _html
import json
import re
import sys

from common import ROOT, fetch, log, norm_space, canon_corps

PARSED = ROOT / "data" / "parsed"
SOURCE = "https://downbeatdesigns.com/dci_{year}"

# div-head labels -> the class names the rest of the pipeline expects
CLASS_MAP = {
    "world class": "World Class",
    "open class": "Open Class",
    "all-age": "All-Age",
    "all age": "All-Age",
    "soundsport": "SoundSport",
    "international": "International",
}

_SECTION = re.compile(r'<section class="score-event">(.*?)</section>', re.S)
_TITLE = re.compile(r'class="se-title">(.*?)</h2>', re.S)
_META = re.compile(r'class="event-meta">(.*?)</p>', re.S)
_RECAP = re.compile(r'class="recap-link"\s+href="([^"]+)"')
_CARD = re.compile(r'<div class="div-card">\s*<h3 class="div-head">(.*?)</h3>(.*?)</div>\s*(?=<div class="div-card">|$)', re.S)
_ROW = re.compile(
    r'<div class="div-row">\s*'
    r'<span class="rank">(\d+)</span>\s*'
    r'<span class="corps">(.*?)</span>\s*'
    r'<span class="score">([\d.]+)</span>',
    re.S,
)


def _clean(s: str) -> str:
    return norm_space(_html.unescape(re.sub(r"<[^>]+>", "", s or "")))


def _canonical_dci_url(recap_href: str) -> str | None:
    """.../scores/recap/<slug>/ -> .../scores/final-scores/<slug>/ so the
    entry lines up with scrape_dci.py's own key for the same show."""
    m = re.search(r"/scores/recap/([^/]+)/?", recap_href or "")
    if not m:
        return None
    return f"https://www.dci.org/scores/final-scores/{m.group(1)}/"


def parse_downbeat(page: str) -> list[dict]:
    events: list[dict] = []
    for body in _SECTION.findall(page):
        tm, mm, rm = _TITLE.search(body), _META.search(body), _RECAP.search(body)
        if not (tm and rm):
            continue
        url = _canonical_dci_url(rm.group(1))
        if not url:
            continue
        slug = url.rstrip("/").rsplit("/", 1)[-1]
        name = re.sub(r"\s+Results$", "", _clean(tm.group(1)))
        name = re.sub(r"^\d{4}\s+", "", name)  # "2026 Brass Impact" -> "Brass Impact"
        meta = _clean(mm.group(1)) if mm else ""
        parts = [p.strip() for p in re.split(r"·", meta) if p.strip()]
        location = parts[0] if parts else ""
        year = int(slug[:4]) if slug[:4].isdigit() else None

        classes = []
        for cm in _CARD.finditer(body):
            head, card = cm.group(1), cm.group(2)
            cls = CLASS_MAP.get(_clean(head).lower(), _clean(head))
            results = []
            for rank, corps, score in _ROW.findall(card):
                cn = canon_corps(_clean(corps))
                if not cn:
                    continue
                results.append({"place": int(rank), "corps": cn, "score": float(score)})
            if results:
                classes.append({"class": cls, "results": results})
        if not classes:
            continue

        events.append({
            "url": url,
            "slug": slug,
            "year": year,
            "name": name,
            "date_display": parts[-1] if len(parts) > 1 else "",
            "location": location,
            "recap_url": rm.group(1),
            "classes": classes,
            "source": "downbeatdesigns",
        })
    return events


def _has_results(ev: dict) -> bool:
    return any(c.get("results") for c in ev.get("classes") or [])


def main() -> int:
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    url = SOURCE.format(year=year)
    page = fetch(url, force=True)
    if not page:
        page = fetch(url)  # fall back to cache if the live fetch failed
    if not page:
        log("downbeat: source unreachable and no cache — nothing to do")
        return 0

    fresh = parse_downbeat(page)
    log(f"downbeat: parsed {len(fresh)} shows from {url}")
    if not fresh:
        return 0

    events_path = PARSED / "dci_events.json"
    existing = json.loads(events_path.read_text()) if events_path.exists() else []
    by_url = {e["url"]: e for e in existing}

    added, upgraded, skipped = 0, 0, 0
    for ev in fresh:
        cur = by_url.get(ev["url"])
        if cur is None:
            by_url[ev["url"]] = ev
            added += 1
            log(f"  + fill {ev['name']} ({ev['date_display']}) from downbeat")
        elif not _has_results(cur):
            # a prior empty/stub entry — replace with real scores
            by_url[ev["url"]] = ev
            upgraded += 1
        else:
            skipped += 1  # dci.org already has it (richer) — leave untouched

    if added or upgraded:
        merged = sorted(
            by_url.values(),
            key=lambda e: (e.get("year") or 0, e.get("date_display") or "", e.get("name") or ""),
        )
        events_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1))
        log(f"downbeat: wrote {events_path} (+{added} filled, {upgraded} upgraded, {skipped} kept dci.org)")
    else:
        log(f"downbeat: nothing to fill ({skipped} already covered by dci.org)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
