"""Scrape dci.org upcoming events + lineups for the homepage.

Discovery: event-sitemap.xml lists /events/<year>-<slug>/ pages.
Each event page: h1 = name, "City, ST" text after the h1, first
"Month D, YYYY" in the body = event date, and a "Lineup & Times" table
whose rows are [time, "Corps - City, ST"] mixed with non-performance
rows (Gates Open, Intermission, Encore, Scores Announced …).

Output: data/parsed/dci_upcoming.json
  [{name, date, date_display, location, url, lineup: [corps, …]}, …]

Only current-season pages are fetched; pages whose cached copy parses to
a date in the future (or very recent past) are re-fetched fresh so
lineups stay current.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

from common import ROOT, fetch, log, norm_space, canon_corps, cache_path

PARSED = ROOT / "data" / "parsed"
SITEMAP = "https://www.dci.org/event-sitemap.xml"

MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}
DATE_PAT = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(\d{1,2}),?\s+(\d{4})")
NON_PERFORMANCE = re.compile(
    r"gates open|welcome|national anthem|intermission|scores? announced|"
    r"age.?out recognition|encore|award|color guard|honor guard|pledge|"
    r"opening ceremon|closing ceremon|drum major|meeting|clinic|autograph", re.I)


def iso_from_display(disp: str) -> str | None:
    m = DATE_PAT.search(disp or "")
    if not m:
        return None
    return f"{int(m.group(3)):04d}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}"


def parse_event_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    ev: dict = {"url": url}

    h1 = soup.find("h1")
    if not h1:
        return None
    ev["name"] = norm_space(h1.get_text())

    # location: first "City, ST" style text after the h1
    for el in h1.find_all_next(string=True)[:60]:
        t = norm_space(str(el))
        if re.fullmatch(r"[A-Za-z .'’-]+,\s*[A-Z]{2}", t):
            ev["location"] = t
            break

    body_txt = soup.get_text(" ", strip=True)
    dm = DATE_PAT.search(body_txt)
    if dm:
        ev["date_display"] = f"{dm.group(1)} {dm.group(2)}, {dm.group(3)}"
        ev["date"] = iso_from_display(ev["date_display"])

    # lineup table under the "Lineup & Times" heading; the full timed
    # schedule (gates, step-offs, intermission, scores announced) rides along
    lineup: list[str] = []
    schedule: list[list[str]] = []
    head = soup.find(lambda t: t.name in ("h2", "h3") and "lineup" in t.get_text().lower())
    if head:
        table = head.find_next("table")
        if table:
            for tr in table.find_all("tr"):
                cells = [norm_space(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
                if len(cells) < 2:
                    continue
                time_s, entry = cells[0], cells[-1]
                if not entry:
                    continue
                if NON_PERFORMANCE.search(entry):
                    if len(schedule) < 60:
                        schedule.append([time_s, entry])
                    continue
                # "Corps Name - City, ST" (city part optional)
                name = re.split(r"\s+-\s+", entry)[0]
                name = norm_space(name)
                if not name or len(name) > 60:
                    continue
                cname = canon_corps(name)
                if cname and cname not in lineup:
                    lineup.append(cname)
                    if len(schedule) < 60:
                        schedule.append([time_s, cname])
    ev["lineup"] = lineup
    if schedule and any(t for t, _ in schedule):
        ev["schedule"] = schedule

    # bag policy: venues bury it in the event-details prose — capture the
    # sentence run around the keyword so fans know before they pack
    bag = None
    m = re.search(r"(clear\s+bag|bag\s+polic\w+)", body_txt, re.I)
    if m:
        start = body_txt.rfind(".", 0, m.start()) + 1
        # a heading like "SECURITY, BAG POLICY & PROHIBITED ITEMS:" reads
        # better trimmed to the text after the colon
        colon = body_txt.find(":", m.end())
        if 0 <= colon - m.end() <= 40:
            start = colon + 1
        snippet = norm_space(body_txt[start:start + 420])
        # stop where the page moves on to the next section of boilerplate
        nxt = re.search(r"\b(tickets?|concessions?|parking|directions|accessibilit\w+|watch live|weather)\b",
                        snippet[20:], re.I)
        if nxt:
            snippet = snippet[:20 + nxt.start()]
        # cut at the last full sentence; drop obvious nav/boilerplate tails
        last = snippet.rfind(".")
        if last > 20:
            snippet = snippet[:last + 1]
        snippet = norm_space(snippet)
        if len(snippet) > 25:
            bag = snippet
    if bag:
        ev["bag_policy"] = bag
    return ev if ev.get("date") else None


def main():
    import argparse, time
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-days", type=int, default=10,
                    help="re-fetch only events within this many days (near-term "
                         "lineups/schedules change; distant ones rarely do)")
    ap.add_argument("--deadline", type=int, default=0, metavar="SECONDS",
                    help="stop re-fetching after SECONDS so a DCI outage can't stall")
    args = ap.parse_args()
    start = time.monotonic()

    PARSED.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()

    # try live, but fall back to the CACHED sitemap when DCI throttles it —
    # the cached sitemap + cached event pages can rebuild the whole list
    # offline, so a transient sitemap 403 can't blank the schedule
    xml = fetch(SITEMAP, force=True, retries=1) or ""
    if not xml:
        xml = fetch(SITEMAP) or ""   # force=False → cached copy
        if xml:
            log("live sitemap failed — rebuilding from cached sitemap")
    urls = sorted(set(re.findall(r"<loc>\s*([^<]+/events/[^<]+)\s*</loc>", xml)))
    season = [u for u in urls if re.search(rf"/events/{today.year}-", u)]
    log(f"event sitemap lists {len(urls)} pages, {len(season)} for {today.year}")
    if not season:
        # no cached sitemap either — keep the last good schedule
        log("no event URLs available — keeping existing upcoming.json")
        return

    out = []
    for url in season:
        html = fetch(url)
        if not html:
            continue
        try:
            ev = parse_event_page(url, html)
        except Exception as e:  # noqa: BLE001
            log(f"PARSE FAIL {url}: {e}")
            continue
        if not ev:
            continue
        # refresh only NEAR-term events (lineups/schedules firm up as the show
        # nears); distant ones stay cached. A deadline caps the run so a DCI
        # outage keeps existing data instead of grinding through backoffs.
        evd = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        near = today - timedelta(days=1) <= evd <= today + timedelta(days=args.refresh_days)
        within_deadline = not args.deadline or time.monotonic() - start < args.deadline
        if near and within_deadline and cache_path(url).exists():
            fresh = fetch(url, force=True)
            if fresh:
                try:
                    ev = parse_event_page(url, fresh) or ev
                except Exception:  # noqa: BLE001
                    pass
        out.append(ev)

    if not out:
        log("parsed zero events — keeping existing upcoming.json")
        return

    # merge with the last good list so upcoming shows survive a momentary
    # sitemap hiccup — but distinguish a hiccup (show returns next scrape)
    # from a real removal (DCI cancelled it, gone for good). Each event
    # carries `_seen` = the last day it appeared in a real scrape; a show
    # missing from THIS scrape is kept only while it was seen recently.
    # So: transient miss → kept; genuinely pulled → drops after MISS_DAYS.
    MISS_DAYS = 2
    today_s = str(today)
    for e in out:
        e["_seen"] = today_s
    p = PARSED / "dci_upcoming.json"
    merged = {e["url"]: e for e in out}
    grace = str(today - timedelta(days=1))            # keep through show day
    seen_cutoff = str(today - timedelta(days=MISS_DAYS))
    if p.exists():
        try:
            for e in json.loads(p.read_text()):
                u, d = e.get("url"), e.get("date") or ""
                if not u or u in merged or d < grace:
                    continue
                seen = e.get("_seen") or today_s      # grandfather old entries
                if seen >= seen_cutoff:               # recently seen → a hiccup
                    e.setdefault("_seen", today_s)
                    merged[u] = e
                else:
                    log(f"dropping {e.get('name','?')} — gone from DCI since {seen}")
        except Exception:  # noqa: BLE001
            pass
    final = sorted(merged.values(), key=lambda e: (e.get("date") or "", e.get("name") or ""))
    p.write_text(json.dumps(final, ensure_ascii=False, indent=1))
    future = sum(1 for e in final if e["date"] >= today_s)
    log(f"wrote {p}: {len(final)} events, {future} upcoming ({len(out)} fresh this run)")


if __name__ == "__main__":
    main()
