#!/usr/bin/env python3
"""Fallback score source: drum-corps.net.

A second mirror alongside downbeatdesigns, used when dci.org is
Cloudflare-challenging the runner. drum-corps.net tends to post a show
within minutes of the scores dropping — often ahead of downbeatdesigns —
and lists results in a clean <pre> block, one line per corps. Verified
against known-good dci.org data (DCI Denton 2026): all placements and
scores matched exactly.

Like the downbeat fallback this only *fills* shows dci.org hasn't
delivered and never overwrites dci.org's richer recap data. Each show is
matched to its canonical dci.org final-scores URL (via the upcoming-events
calendar) so entries upgrade in place — no duplicates — once dci.org
reopens.
"""
from __future__ import annotations

import html as _html
import json
import re
import sys

from common import ROOT, fetch, log, norm_space, canon_corps, slugify

PARSED = ROOT / "data" / "parsed"
INDEX = "https://www.drum-corps.net/scores"
SHOW = "https://www.drum-corps.net/scores/dci/{id}"

CLASS_MAP = {
    "world class": "World Class",
    "open class": "Open Class",
    "all age": "All-Age",
    "all-age": "All-Age",
    "soundsport": "SoundSport",
    "international": "International",
    "exhibition": "Exhibition",
}
# section headers that aren't a scored class — ignore their rows
SKIP_SECTIONS = {"exhibition", "soundsport"}

_ROW = re.compile(r"^\s*(\d+)\.\s+(.+?)\s+(\d{1,3}\.\d{2,3})\s*$")


def _norm_name(s: str) -> str:
    s = norm_space(_html.unescape(s))
    s = re.sub(r"\s*\(20\d\d\)\s*$", "", s)        # drop trailing "(2026)"
    return s


def _index_2026() -> list[tuple[str, str]]:
    page = fetch(INDEX, force=True) or fetch(INDEX)
    if not page:
        return []
    seen, out = set(), []
    for m in re.finditer(r'/scores/dci/(\d+)"[^>]*>\s*([^<]*\(20\d\d\))', page):
        sid, raw = m.group(1), m.group(2)
        if sid in seen or "(2026)" not in raw:
            continue
        seen.add(sid)
        out.append((sid, _norm_name(raw)))
    return out


def _canonical_url_map() -> dict[str, str]:
    """normalized event name -> dci.org final-scores URL, from the calendar."""
    up_path = PARSED / "dci_upcoming.json"
    if not up_path.exists():
        return {}
    out = {}
    for e in json.loads(up_path.read_text()):
        u = e.get("url") or ""
        m = re.search(r"/events/([^/]+)/?", u)
        if m and e.get("name"):
            out[_norm_name(e["name"]).lower()] = \
                f"https://www.dci.org/scores/final-scores/{m.group(1)}/"
    return out


def parse_show(page: str) -> tuple[str, str, list[dict]]:
    """Returns (location, date_display, classes)."""
    loc, date_disp = "", ""
    mc = re.search(r'entry-content">\s*<p>\s*(.*?)</p>', page, re.S)
    if mc:
        txt = norm_space(re.sub(r"<[^>]+>", " ", mc.group(1)))
        parts = [p.strip() for p in txt.split(",")]
        m2 = re.search(r"([A-Z][a-z]+ \d{1,2}, 20\d\d)", txt)
        if m2:
            date_disp = m2.group(1)
        loc = re.sub(r"\s+[A-Z][a-z]+ \d{1,2}, 20\d\d.*$", "", txt).strip(" ,")
    pm = re.search(r"<pre>(.*?)</pre>", page, re.S)
    if not pm:
        return loc, date_disp, []
    body = _html.unescape(pm.group(1))
    classes, cur, results = [], None, []

    def flush():
        nonlocal cur, results
        if cur and cur.lower() not in SKIP_SECTIONS and results:
            classes.append({"class": CLASS_MAP.get(cur.lower(), cur), "results": results})
        results = []

    for line in body.splitlines():
        line = norm_space(re.sub(r"<[^>]+>", "", line))
        if not line:
            continue
        rm = _ROW.match(line)
        if rm:
            corps = canon_corps(rm.group(2))
            if corps:
                results.append({"place": int(rm.group(1)), "corps": corps,
                                "score": float(rm.group(3))})
        elif not re.match(r"^\d", line) and len(line) < 40:
            # a section header (e.g. "World Class") — start a new class
            flush()
            cur = line
    flush()
    return loc, date_disp, classes


def _has_results(ev: dict) -> bool:
    return any(c.get("results") for c in ev.get("classes") or [])


def main() -> int:
    shows = _index_2026()
    if not shows:
        log("drum-corps.net: index unreachable — nothing to do")
        return 0
    url_map = _canonical_url_map()

    events_path = PARSED / "dci_events.json"
    existing = json.loads(events_path.read_text()) if events_path.exists() else []
    by_url = {e["url"]: e for e in existing}

    added = upgraded = skipped = 0
    # newest shows first (highest id); cap the work — older shows are cached
    for sid, name in sorted(shows, key=lambda s: -int(s[0]))[:12]:
        url = url_map.get(name.lower())
        if not url:  # not on the calendar — best-effort canonical slug
            url = f"https://www.dci.org/scores/final-scores/2026-{slugify(name)}/"
        cur = by_url.get(url)
        if cur is not None and _has_results(cur):
            skipped += 1
            continue  # dci.org (or another fill) already has it
        page = fetch(SHOW.format(id=sid), force=True) or fetch(SHOW.format(id=sid))
        if not page:
            continue
        loc, date_disp, classes = parse_show(page)
        if not classes:
            continue
        slug = url.rstrip("/").rsplit("/", 1)[-1]
        ev = {
            "url": url, "slug": slug,
            "year": int(slug[:4]) if slug[:4].isdigit() else 2026,
            "name": name, "date_display": date_disp, "location": loc,
            "recap_url": f"https://www.dci.org/scores/recap/{slug}/",
            "classes": classes, "source": "drum-corps.net",
        }
        if cur is None:
            added += 1
            log(f"  + fill {name} ({date_disp}) from drum-corps.net")
        else:
            upgraded += 1
        by_url[url] = ev

    if added or upgraded:
        merged = sorted(by_url.values(),
                        key=lambda e: (e.get("year") or 0, e.get("date_display") or "", e.get("name") or ""))
        events_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1))
        log(f"drum-corps.net: wrote {events_path} (+{added} filled, {upgraded} upgraded, {skipped} kept)")
    else:
        log(f"drum-corps.net: nothing to fill ({skipped} already covered)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
