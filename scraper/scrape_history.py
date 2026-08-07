"""Scrape pre-2013 drum corps history from dcxmuseum.org (DCX / MPAM).

Discovery: each year has a gallery page at
    index.cfm?roomid=<decade-room>&view=decade&option=<year>
that links every show of that year as ShowID=<year><seq> (sequences are
NOT contiguous or 1-based — 1970 runs 100..311 — so the year pages are
the authoritative list, never blind enumeration).

Show pages (index.cfm?view=show&ShowID=…&showsummary=no) render one table:
    row 0: "<Show Name?> Month D, YYYY City ST"   (name prefix optional)
    row 1: Division | Position | Corps | Score
    rows:  <division> | <place> | <corps> | <score>

Pages are cached by common.fetch, so chunked runs (--max-fetches) resume
where they left off.

Output: data/parsed/history_events.json — same event schema as the
DCI.org scraper, with source="dcx". build_data.py merges it for years
DCI.org doesn't cover (pre-2013).

Usage:
  python scrape_history.py                      # 1972..2012
  python scrape_history.py --from 1980 --to 1989
  python scrape_history.py --max-fetches 600    # bounded chunk
"""
from __future__ import annotations

import argparse
import json
import re

from bs4 import BeautifulSoup

from common import ROOT, fetch, log, norm_space, canon_corps, cache_path

PARSED = ROOT / "data" / "parsed"
BASE = "https://www.dcxmuseum.org/index.cfm?view=show&ShowID={sid}&showsummary=no"
YEAR_PAGE = "https://www.dcxmuseum.org/index.cfm?roomid={room}&view=decade&option={year}"


def decade_room(year: int) -> int:
    # rooms 1301..1311 map to decades 1920..2020
    return 1301 + (year // 10 * 10 - 1920) // 10


def show_ids_for_year(year: int, force: bool = False) -> list[int]:
    html = fetch(YEAR_PAGE.format(room=decade_room(year), year=year), force=force)
    if not html:
        return []
    ids = sorted({int(m) for m in re.findall(r"ShowID=(\d{7})", html)
                  if int(m) // 1000 == year})
    return ids

MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}
TITLE_PAT = re.compile(
    r"^(?P<name>.*?)\s*(?P<month>January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(?P<day>\d{1,2}),?\s+(?P<year>\d{4})\s*(?P<loc>.*)$")

ALL_AGE = re.compile(r"all.?age|dca|senior", re.I)
OPEN_MODERN = re.compile(r"open|division\s*(ii|iii|2|3)|class\s*a", re.I)
WORLD_MODERN = re.compile(r"world|division\s*(i|1)\b", re.I)


def class_for(division: str, year: int) -> str:
    """Map DCX's division labels onto the site's canonical classes.
    Pre-1992 'Open (Class)' was the *top* division, so it maps to World
    Class; from 1992 on the modern World/Open split applies."""
    d = norm_space(division or "")
    if not d:
        return "World Class"
    if ALL_AGE.search(d):
        return "All-Age"
    if year < 1992:
        return "World Class" if (WORLD_MODERN.search(d) or OPEN_MODERN.search(d)) else d.title()
    if WORLD_MODERN.search(d):
        return "World Class"
    if OPEN_MODERN.search(d):
        return "Open Class"
    return d.title()


def parse_show_page(html: str, year: int, sid: int) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    table = None
    for t in soup.find_all("table"):
        head = t.get_text(" ", strip=True)
        if "Position" in head and "Corps" in head:
            table = t
            break
    if table is None:
        return None

    rows = table.find_all("tr")
    ev: dict = {
        "url": BASE.format(sid=sid), "slug": f"dcx-{sid}", "year": year,
        "source": "dcx",
    }
    body_start = 0
    for i, tr in enumerate(rows[:3]):
        txt = norm_space(tr.get_text(" ", strip=True))
        m = TITLE_PAT.match(txt)
        if m and m.group("year") and "Position" not in txt:
            name = norm_space(m.group("name"))
            loc = norm_space(m.group("loc"))
            # "La Crosse WI" -> "La Crosse, WI"
            lm = re.fullmatch(r"(.+?)\s+([A-Z]{2})", loc)
            if lm:
                loc = f"{lm.group(1)}, {lm.group(2)}"
            ev["location"] = loc or None
            ev["date_display"] = f"{m.group('month')} {int(m.group('day'))}, {m.group('year')}"
            ev["date"] = f"{int(m.group('year')):04d}-{MONTHS[m.group('month')]:02d}-{int(m.group('day')):02d}"
            ev["name"] = name or (f"{loc} Show" if loc else f"Show #{sid % 1000}")
            body_start = i + 1
            break
    if "name" not in ev:
        ev["name"] = f"Show #{sid % 1000}"

    by_class: dict[str, list] = {}
    for tr in rows[body_start:]:
        cells = [norm_space(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
        if len(cells) < 4 or cells[1] == "Position":
            continue
        division, pos, corps, score = cells[0], cells[1], cells[2], cells[3]
        corps = canon_corps(corps)
        if not corps:
            continue
        pm = re.fullmatch(r"(\d{1,3})\.?", pos)
        sm = re.search(r"(\d{1,3}\.\d{1,3})", score)
        place = int(pm.group(1)) if pm else None
        sc = float(sm.group(1)) if sm else None
        if sc is not None and (sc < 20 or sc > 100):
            sc = None
        if place is None and sc is None:
            continue
        by_class.setdefault(class_for(division, year), []).append(
            {"place": place, "corps": corps, "score": sc})

    classes = []
    for cls, results in by_class.items():
        results.sort(key=lambda r: (r["place"] if r["place"] is not None else 99,
                                    -(r["score"] or 0)))
        classes.append({"class": cls, "results": results})
    ev["classes"] = classes
    return ev if classes else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="y0", type=int, default=1972)
    ap.add_argument("--to", dest="y1", type=int, default=2012)
    ap.add_argument("--max-fetches", type=int, default=0,
                    help="stop after N live fetches (0 = unlimited); cached pages don't count")
    ap.add_argument("--reparse", action="store_true",
                    help="re-parse cached pages without refetching")
    args = ap.parse_args()

    PARSED.mkdir(parents=True, exist_ok=True)
    out_path = PARSED / "history_events.json"
    existing: dict[str, dict] = {}
    if out_path.exists() and not args.reparse:
        for e in json.loads(out_path.read_text()):
            existing[e["url"]] = e

    fetches = [0]

    def budget_fetch(url):
        cached = cache_path(url).exists()
        if not cached:
            if args.max_fetches and fetches[0] >= args.max_fetches:
                return None, False
            fetches[0] += 1
        return fetch(url), True

    budget_hit = False
    for year in range(args.y0, args.y1 + 1):
        if budget_hit:
            break
        ids = show_ids_for_year(year)
        found = 0
        for sid in ids:
            url = BASE.format(sid=sid)
            if url in existing and not args.reparse:
                found += 1
                continue
            html, attempted = budget_fetch(url)
            if not attempted:
                budget_hit = True    # out of budget — resume next run
                break
            if html is None:
                continue             # hard fetch failure — retried next run
            try:
                ev = parse_show_page(html, year, sid)
            except Exception as e:  # noqa: BLE001
                log(f"PARSE FAIL {url}: {e}")
                ev = None
            if ev:
                existing[ev["url"]] = ev
                found += 1
        log(f"{year}: {found}/{len(ids)} shows ({fetches[0]} live fetches so far)"
            + (" [budget hit]" if budget_hit else ""))

    events = sorted(existing.values(),
                    key=lambda e: (e.get("year") or 0, e.get("date") or "", e.get("name") or ""))
    out_path.write_text(json.dumps(events, ensure_ascii=False, indent=1))
    log(f"wrote {out_path}: {len(events)} events ({fetches[0]} live fetches)")


if __name__ == "__main__":
    main()
