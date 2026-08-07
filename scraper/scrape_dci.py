"""Scrape dci.org competition results (the ONLY data source for the site).

Discovery: competition sitemaps (all /scores/final-scores/ URLs, 2013-present).
Parsing: dci.org renders results either as div-based "score-tbl" blocks
(shortcode) or as plain HTML tables depending on template era — both handled.
Caption recaps live at /scores/recap/<slug>/ (robots-allowed).

Usage:
  python scrape_dci.py                      # incremental (uncached only)
  python scrape_dci.py --season 2026 --force
  python scrape_dci.py --season 2019        # backfill one season
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

from common import ROOT, fetch, log, norm_space, canon_corps

PARSED = ROOT / "data" / "parsed"
SITEMAP_INDEX = "https://www.dci.org/wp-sitemap.xml"

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}


def _event_age_days(ev) -> int | None:
    """Whole days between an event's date and today (UTC). None if unknown.
    Negative for future dates. Used to decide which events are worth
    re-fetching: a show from last week never changes, so re-scraping it
    every cycle just hammers DCI and drags the run out when they throttle."""
    m = re.match(r"(\w+)\s+(\d{1,2}),?\s+(\d{4})", ev.get("date_display") or "")
    if not m or m.group(1) not in _MONTHS:
        return None
    try:
        d = datetime(int(m.group(3)), _MONTHS[m.group(1)], int(m.group(2)), tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - d).days

# Events that are individual/ensemble showcases, not corps competitions
NON_CORPS_EVENT = re.compile(r"individual|\bi ?& ?e\b|soundsport|drumline battle", re.I)
PLACEHOLDER_ROW = re.compile(r"^(not scored|tba|tbd|--?|—)$", re.I)


def _scores_urls_from_calendar(days_back: int = 6) -> list[str]:
    """Final-scores URLs derived from recently-passed events on the upcoming
    calendar (data/parsed/dci_upcoming.json). DCI uses the same slug for an
    event page (/events/<slug>/) and its results (/scores/final-scores/
    <slug>/), so once a show's date passes we can check its scores page
    directly instead of waiting for the lagging competition sitemap."""
    p = PARSED / "dci_upcoming.json"
    if not p.exists():
        return []
    try:
        cal = json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return []
    today = datetime.now(timezone.utc).date()
    out = []
    for e in cal:
        d = e.get("date")
        u = e.get("url") or ""
        if not d or "/events/" not in u:
            continue
        try:
            evd = datetime.strptime(d, "%Y-%m-%d").date()
        except ValueError:
            continue
        # a show that has happened (through today) within the look-back window
        if 0 <= (today - evd).days <= days_back:
            out.append(u.replace("/events/", "/scores/final-scores/"))
    return sorted(set(out))


def get_competition_urls() -> list[str]:
    urls: list[str] = []
    # try live (retries=2, fail fast) but fall back to the CACHED sitemap
    # when DCI throttles — cached sitemap + cached event pages rebuild the
    # dataset offline instead of leaving it stuck
    idx = fetch(SITEMAP_INDEX, force=True, retries=1) or fetch(SITEMAP_INDEX)
    maps = re.findall(r"<loc>\s*([^<]+competition-sitemap\d*\.xml)\s*</loc>", idx or "")
    if not maps:
        maps = [f"https://www.dci.org/competition-sitemap{n}.xml" for n in ("", "2", "3", "4")]
    for m in maps:
        xml = fetch(m, force=True, retries=1) or fetch(m)
        if not xml:
            log(f"WARNING: sitemap fetch failed: {m}")
            continue
        urls += re.findall(r"<loc>\s*([^<]+/scores/final-scores/[^<]+)\s*</loc>", xml)
    urls = sorted(set(u.strip() for u in urls))
    log(f"sitemaps list {len(urls)} competition URLs")
    return urls


def year_of(url: str) -> int | None:
    m = re.search(r"/final-scores/(\d{4})-", url)
    return int(m.group(1)) if m else None


def _clean_heading(s: str) -> str:
    s = norm_space(s)
    s = re.sub(r"\s*(final scores|scores|results)\s*$", "", s, flags=re.I)
    return s


def _row_from_cols(place_txt: str, corps_txt: str, score_txt: str):
    corps_txt = norm_space(corps_txt)
    place_txt = norm_space(place_txt)
    score_txt = norm_space(score_txt)
    if not corps_txt or PLACEHOLDER_ROW.match(corps_txt):
        return None
    if PLACEHOLDER_ROW.match(place_txt) and PLACEHOLDER_ROW.match(score_txt or "-"):
        return None
    sm = re.fullmatch(r"(\d{1,3}\.\d{1,3})", score_txt)
    score = float(sm.group(1)) if sm else None
    pm = re.fullmatch(r"(\d{1,2})\.?", place_txt)
    place = int(pm.group(1)) if pm else None
    if score is not None and score < 20:  # exhibitions/placeholders render as 0.0
        score = None
    if place is not None and place < 1:
        place = None
    if score is None and place is None:
        return None
    return {"place": place, "corps": canon_corps(corps_txt), "score": score}


def parse_event_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    ev: dict = {"url": url, "slug": url.rstrip("/").split("/")[-1], "year": year_of(url)}

    # Name from the slug (h1 is a generic "Official DCI Scores")
    name = ev["slug"]
    name = re.sub(r"^\d{4}-", "", name).replace("-", " ")
    name = re.sub(r"\s+", " ", name).strip().title()
    name = name.replace("Dci", "DCI").replace("Usbands", "USBands").replace(" Of ", " of ").replace(" The ", " the ").replace(" At ", " at ").replace(" And ", " and ")
    h1 = soup.find("h1")
    if h1:
        t = norm_space(h1.get_text())
        if t and "official dci scores" not in t.lower() and len(t) > 3:
            name = re.sub(r"^\d{4}\s+", "", t)
    ev["name"] = name

    # date & location from the score-date-location block
    sdl = soup.find(class_="score-date-location")
    if sdl:
        txt = norm_space(sdl.get_text(" ", strip=True))
        dm = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}", txt)
        if dm:
            ev["date_display"] = dm.group(0)
        lm = re.search(r"([A-Za-z .'-]+,\s*[A-Z]{2})\b", txt)
        if lm:
            ev["location"] = norm_space(lm.group(1))
    if "date_display" not in ev:
        m = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+(\d{4})", soup.get_text(" ", strip=True))
        if m:
            ev["date_display"] = m.group(0)

    recap_a = soup.find("a", href=re.compile(r"/scores/recap/"))
    if recap_a and recap_a.get("href") and recap_a["href"].strip() not in ("#", ""):
        href = recap_a["href"]
        if href.startswith("/"):
            href = "https://www.dci.org" + href
        ev["recap_url"] = href
    else:
        ev["recap_url"] = f"https://www.dci.org/scores/recap/{ev['slug']}/"

    classes: list[dict] = []

    def add_class(cls_name, rows):
        cls_name = _clean_heading(cls_name or "Results")
        if not rows:
            return
        for c in classes:
            if c["class"].lower() == cls_name.lower():
                c["results"].extend(rows)
                return
        classes.append({"class": cls_name, "results": rows})

    # --- Primary: div-based score tables inside shortcode blocks ---
    for st in soup.select(".elementor-shortcode .score-tbl, .score-tbl.finalscores"):
        # skip demo/hidden widget copies
        hidden_parent = st.find_parent(class_=re.compile(r"elementor-hidden"))
        if hidden_parent:
            continue
        cur_cls = None
        # heading may precede the block
        prev_h = st.find_previous(["h2", "h3"])
        if prev_h and _clean_heading(prev_h.get_text()) and "score-division-name" not in (prev_h.get("class") or []):
            t = _clean_heading(prev_h.get_text())
            if t and len(t) < 50 and not re.search(r"official dci", t, re.I):
                cur_cls = t
        rows: list[dict] = []
        for child in st.descendants:
            if getattr(child, "name", None) == "h2" and "score-division-name" in (child.get("class") or []):
                if rows:
                    add_class(cur_cls, rows)
                    rows = []
                cur_cls = _clean_heading(child.get_text())
            elif getattr(child, "name", None) == "div" and "tbl-row" in (child.get("class") or []):
                if "poweredby-row" in (child.get("class") or []):
                    continue
                cols = child.select(".col-2, .col-7, .col-3")
                place = corps = score = ""
                for c in cols:
                    cl = c.get("class") or []
                    if "col-2" in cl:
                        place = c.get_text(" ", strip=True)
                    elif "col-7" in cl:
                        corps = c.get_text(" ", strip=True)
                    elif "col-3" in cl:
                        score = c.get_text(" ", strip=True)
                if "view full recap" in (corps + score).lower():
                    continue
                r = _row_from_cols(place, corps, score)
                if r:
                    rows.append(r)
        if rows:
            add_class(cur_cls, rows)

    # --- Fallback: genuine HTML tables (older/championship templates) ---
    if not classes:
        for table in soup.find_all("table"):
            headers = [norm_space(th.get_text()).lower() for th in table.find_all("th")]
            if headers and "corps" not in " ".join(headers):
                continue
            cls = None
            for prev in table.find_all_previous(["h2", "h3", "h4"]):
                t = _clean_heading(prev.get_text())
                if t and len(t) < 50 and not re.search(r"official dci|final scores", t, re.I):
                    cls = t
                    break
            rows = []
            for tr in table.find_all("tr"):
                tds = [norm_space(td.get_text()) for td in tr.find_all("td")]
                if len(tds) < 2:
                    continue
                nums = [t for t in tds if re.fullmatch(r"\d{1,2}", t)]
                scores = [t for t in tds if re.fullmatch(r"\d{1,3}\.\d{1,3}", t)]
                names = [t for t in tds if t and not re.fullmatch(r"[\d.]+", t)]
                if names and (scores or nums):
                    rows.append({"place": int(nums[0]) if nums else None,
                                 "corps": canon_corps(names[0]),
                                 "score": float(scores[-1]) if scores else None})
            if rows:
                classes.append({"class": cls or "Results", "results": rows})

    # normalize placements within each class
    for c in classes:
        c["results"] = [r for r in c["results"] if r["corps"]]
        c["results"].sort(key=lambda r: (r["place"] if r["place"] is not None else 99,
                                         -(r["score"] or 0)))
        for i, r in enumerate(c["results"]):
            if r["place"] is None:
                r["place"] = i + 1

    ev["classes"] = [c for c in classes if c["results"]]
    if NON_CORPS_EVENT.search(ev["name"]):
        ev["non_corps"] = True
    return ev if ev["classes"] else None


CAPTION_PAT = re.compile(
    r"(general effect|visual|color ?guard|music|brass|percussion|analysis|proficiency|guard|effect)", re.I)

# A recap row is a header fragment only when the whole name IS a caption
# label — substring tests eat real corps ("Santa Clara Vanguard" ⊃ "guard",
# "Music City" ⊃ "music"), so match the full cell.
CAPTION_LABEL = re.compile(
    r"(corps|general effect|visual|music|color ?guard|brass|percussion|analysis|"
    r"proficiency|guard|effect|sub ?-?total|total|penalt(?:y|ies))(\s*[-–]\s*\w+)?(\s+\d+)?", re.I)


def parse_recap_page(url: str, html: str) -> list[dict]:
    """Caption recaps. dci.org recap pages render one wide table per class
    (genuine <table> in all observed templates); keep cells raw-but-clean so
    the front-end can show the full caption grid."""
    soup = BeautifulSoup(html, "lxml")
    out = []
    for table in soup.find_all("table"):
        txt = table.get_text(" ", strip=True).lower()
        if not CAPTION_PAT.search(txt):
            continue
        cls = None
        for prev in table.find_all_previous(["h2", "h3", "h4"]):
            t = norm_space(prev.get_text())
            if t and len(t) < 60 and not re.search(r"recap|final scores|official", t, re.I):
                cls = t
                break
        header_cells: list[str] = []
        for tr in table.find_all("tr")[:3]:
            names = [norm_space(c.get_text()) for c in tr.find_all(["th", "td"])]
            if sum(1 for n in names if CAPTION_PAT.search(n)) >= 3:
                header_cells = names
                break
        rows = []
        for tr in table.find_all("tr"):
            cells = [norm_space(c.get_text()) for c in tr.find_all("td")]
            if len(cells) < 4:
                continue
            name_cells = [c for c in cells[:3] if c and not re.fullmatch(r"[\d. ]+", c)]
            if not name_cells:
                continue
            corps = canon_corps(re.sub(r"\s*-\s*$", "", name_cells[0]))
            numbers = re.findall(r"\d{1,3}\.\d{1,3}", " ".join(cells))
            if not numbers or not corps or CAPTION_LABEL.fullmatch(corps):
                continue
            rows.append({"corps": corps, "total": max(float(n) for n in numbers), "cells": cells})
        if rows:
            out.append({"class": cls or "Results", "captions": header_cells, "rows": rows})
    # div-based fallback
    if not out:
        for st in soup.select(".score-tbl, .recap-tbl"):
            rows = []
            for child in st.select(".tbl-row"):
                cells = [norm_space(x.get_text(" ", strip=True)) for x in child.select("[class*=col-]")]
                cells = [c for c in cells if c]
                if len(cells) >= 4 and any(re.fullmatch(r"\d{1,3}\.\d{1,3}", c) for c in cells):
                    nm = next((c for c in cells if not re.fullmatch(r"[\d.]+", c)), None)
                    if nm:
                        nums = [float(x) for x in re.findall(r"\d{1,3}\.\d{1,3}", " ".join(cells))]
                        rows.append({"corps": canon_corps(nm), "total": max(nums), "cells": cells})
            if rows:
                out.append({"class": "Results", "captions": [], "rows": rows})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--force", action="store_true",
                    help="re-fetch every event in --season (heavy; for backfills)")
    ap.add_argument("--force-recent", type=int, default=0, metavar="DAYS",
                    help="re-fetch only events dated within DAYS (catches score "
                         "corrections + newly posted recaps without re-scraping "
                         "the whole season every run)")
    ap.add_argument("--since", type=int, default=2013)
    ap.add_argument("--reparse", action="store_true",
                    help="re-parse cached pages without refetching")
    ap.add_argument("--max-fetches", type=int, default=0,
                    help="stop after N live fetches (0 = unlimited); cached pages don't count")
    ap.add_argument("--deadline", type=int, default=0, metavar="SECONDS",
                    help="stop starting new network fetches after SECONDS so a "
                         "DCI outage/throttle can't stall the run (0 = no limit); "
                         "already-cached pages still load, so data stays intact")
    args = ap.parse_args()
    import time as _time
    _start = _time.monotonic()

    PARSED.mkdir(parents=True, exist_ok=True)
    existing_path = PARSED / "dci_events.json"
    existing: dict[str, dict] = {}
    if existing_path.exists() and not args.reparse:
        for e in json.loads(existing_path.read_text()):
            existing[e["url"]] = e

    from common import cache_path
    urls = [u for u in get_competition_urls()
            if (year_of(u) or 0) >= args.since
            and (args.season is None or year_of(u) == args.season)]

    # DCI's competition sitemap lags — a show's final-scores page can go live
    # hours before the sitemap lists it. So don't wait on the sitemap: for
    # every recently-passed event on the upcoming calendar, derive its
    # scores URL (same slug) and check it directly. This is how last night's
    # shows get discovered the moment DCI posts them.
    derived = _scores_urls_from_calendar(days_back=8)
    known = set(urls)
    added = [u for u in derived
             if u not in known
             and (args.season is None or year_of(u) == args.season)]
    if added:
        # newly-finished shows are the whole point of this run — fetch them
        # FIRST, before DCI throttling can burn the time budget on routine
        # re-checks and skip them (they were being appended last and starved)
        urls = added + [u for u in urls if u not in set(added)]
        log(f"+{len(added)} candidate score pages derived from the event calendar (fetched first)")

    fetches = [0]

    deadline_hit = [False]

    def budget_fetch(u, force=False):
        cached = cache_path(u).exists() and not force
        if not cached and args.max_fetches and fetches[0] >= args.max_fetches:
            return None
        # a network fetch after the deadline is skipped (existing data kept);
        # cached reads always proceed so the dataset stays complete
        if not cached and args.deadline and _time.monotonic() - _start > args.deadline:
            if not deadline_hit[0]:
                log(f"deadline {args.deadline}s reached — keeping cached/existing data for the rest")
                deadline_hit[0] = True
            return None
        if not cached:
            fetches[0] += 1
        return fetch(u, force=force)

    def want_force(url):
        # in-season only
        if not (args.season is None or year_of(url) == args.season):
            return False
        if args.force:
            return True
        if args.force_recent:
            prev = existing.get(url)
            if prev is None:
                return True  # never seen — but it'll fetch anyway (not cached)
            age = _event_age_days(prev)
            if age is None or -3 <= age <= args.force_recent:
                return True  # recent past / near-future — scores may still move
            # a past show still WITHOUT scores is waiting on late results —
            # keep checking it regardless of age so late posts aren't missed
            if not any(c.get("results") for c in prev.get("classes") or []):
                return True
            return False
        return False

    added_set = set(added) if added else set()
    diag = {}  # derived-URL outcomes, written to a committed file for debugging
    events, skipped = [], 0
    for i, url in enumerate(urls):
        force = want_force(url)
        if url in existing and not force and cache_path(url).exists() is False:
            # previously parsed but page not cached (old run) — keep unless
            # reparsing. Still heal a recap the old run never cached: fetch it
            # within budget so every sheet eventually reaches full fidelity.
            ev = existing[url]
            ru = ev.get("recap_url")
            if ru and not ev.get("non_corps") and not cache_path(ru).exists():
                rhtml = budget_fetch(ru)
                if rhtml:
                    try:
                        rec = parse_recap_page(ru, rhtml)
                        if rec:
                            ev["recap"] = rec
                    except Exception as e:  # noqa: BLE001
                        log(f"PARSE FAIL recap {ru}: {e}")
            events.append(ev)
            continue
        html = budget_fetch(url, force=force)
        if html is None:
            if url in added_set:
                # raw probe to record the EXACT status (403 throttle vs 404
                # wrong-slug vs connection error) — one request, diagnostic only
                try:
                    from common import http_get
                    code, body, _rh = http_get(url, timeout=15)
                    diag[url] = f"HTTP {code}, body {len(body)}B"
                except Exception as pe:  # noqa: BLE001
                    diag[url] = f"request error: {type(pe).__name__}: {pe}"
            if url in existing:
                events.append(existing[url])
            else:
                skipped += 1
            continue
        try:
            ev = parse_event_page(url, html)
        except Exception as e:  # noqa: BLE001
            log(f"PARSE FAIL event {url}: {e}")
            ev = None
        if not ev:
            if url in added_set:
                diag[url] = f"fetched {len(html)}B but parse produced no event (no date/results)"
            continue
        if url in added_set:
            ns = sum(len(c.get("results") or []) for c in ev.get("classes") or [])
            diag[url] = f"fetched {len(html)}B → parsed, {ns} scores"
        if ev.get("recap_url") and not ev.get("non_corps"):
            rhtml = budget_fetch(ev["recap_url"], force=force)
            if rhtml:
                try:
                    rec = parse_recap_page(ev["recap_url"], rhtml)
                    if rec:
                        ev["recap"] = rec
                except Exception as e:  # noqa: BLE001
                    log(f"PARSE FAIL recap {ev['recap_url']}: {e}")
        events.append(ev)
        if (i + 1) % 50 == 0:
            log(f"...{i + 1}/{len(urls)} ({fetches[0]} live fetches)")

    # merge back anything outside the selected slice
    merged = {e["url"]: e for e in (existing.values() if (args.season or args.max_fetches) else [])}
    for e in events:
        merged[e["url"]] = e
    all_events = list(merged.values())
    all_events.sort(key=lambda e: (e.get("year") or 0, e.get("date_display") or "", e.get("name") or ""))
    existing_path.write_text(json.dumps(all_events, ensure_ascii=False, indent=1))
    log(f"wrote {existing_path}: {len(all_events)} events ({fetches[0]} live fetches, {skipped} unreachable)")

    # derived-URL debug trail (committed) — tells us exactly what happened to
    # each newly-discovered show's fetch, so a stuck show is diagnosable
    if added:
        for u in added:
            diag.setdefault(u, "not reached (deadline hit before it / not processed)")
        (PARSED / "derived_diag.json").write_text(json.dumps(diag, ensure_ascii=False, indent=1))
        for u, r in diag.items():
            log(f"  derived {u.split('/')[-2]}: {r}")


if __name__ == "__main__":
    main()
