#!/usr/bin/env python3
"""ISSMA (Indiana) marching band ingest — State Finals placements, 1973-today.

HONESTY MODEL — ISSMA's scored results have been behind its Directors-Only
login since 2005 (verified via Wayback CDX; see data/circuit-probes/issma.md).
We do NOT touch the login wall. The public record is placements only:

  https://www.issma.net/mbhistory.php
      every Marching Band State Finals placement 1973-2025 on one inline-HTML
      page (Class A/B/C from 1973, Class D from 1981, Scholastic A/B from
      2013; no 2020 — COVID). No scores are published, ever.
  https://www.issma.net/statembresults.php
      the current season's Open Class State Finals placements (Class A-D).
  https://www.issma.net/statescholasticmbresults.php
      the current season's Scholastic Class Finals placements — occasionally
      fuller than mbhistory (e.g. the 2025 Scholastic B 5th-place tie).
  https://www.issma.net/mbinfo.php  (#sites)
      the coming fall's full round-by-round performance-site schedule.

So every result row carries  score: null  plus "placement" (the published
State Finals ordinal, standard competition ranking — real ties kept), and
meta.json says  series_kind: "placement".  records top/finals stay empty:
there are no point scores to rank.

Everything goes through the shared rate-limited, gzip-cached fetch(); reruns
parse from data/raw/www.issma.net/ for free. Validation gates (sequential
ranks, no duplicate bands, no fabricated scores, full champions coverage)
abort the write on any failure.
"""
from __future__ import annotations

import argparse
import hashlib
import html as htmllib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import quote

from common import ROOT, fetch, log, norm_space, slugify

BASE = "https://www.issma.net"
HISTORY_URL = f"{BASE}/mbhistory.php"
STATE_URL = f"{BASE}/statembresults.php"
SCHOL_URL = f"{BASE}/statescholasticmbresults.php"
MBINFO_URL = f"{BASE}/mbinfo.php"
DOCS = ROOT / "docs" / "issma" / "data"

CLASS_ORDER = ["Class A", "Class B", "Class C", "Class D",
               "Scholastic A", "Scholastic B"]
# first season each class appears at State Finals (validation gates key off
# this; 2020 was cancelled — COVID — and is expected missing everywhere)
CLASS_FIRST = {"Class A": 1973, "Class B": 1973, "Class C": 1973,
               "Class D": 1981, "Scholastic A": 2013, "Scholastic B": 2013}
FIRST_YEAR, COVID = 1973, {2020}

# ---------------------------------------------------------------------------
# name canonicalization — thread one identity through 50+ years of typography
# ---------------------------------------------------------------------------

# printed-form fixes verified row-by-row against the surrounding years/classes
# (e.g. 'Coydon' sits in Corydon Central's unbroken Class C run)
SCHOOL_ALIASES = {
    "Coydon": "Corydon Central",
    "Anderson Highland": "Highland, Anderson",
    "Evansville North": "North, Evansville",
    "New Castle": "New Castle Chrysler",
    "Rensselaer": "Rensselaer Central",
    "Bedford-North Lawrence": "Bedford North Lawrence",
    "Bloomington H.S. North": "Bloomington North",
    "Bloomington HS North": "Bloomington North",
    "Marion-Adams, Sheridan": "Sheridan",     # Sheridan HS, Marion-Adams corp
    "Jefferson, Lafayette": "Lafayette Jefferson",
    # statembresults.php prints full corporation names; mbhistory shortens
    "Greenwood Community": "Greenwood",
    "Zionsville Community": "Zionsville",
}
CITY_ALIASES = {
    "Indpls.": "Indianapolis", "Indpls": "Indianapolis",
    "Ft. Wayne": "Fort Wayne", "Ft. Branch": "Fort Branch",
    "Floyd Knobs": "Floyds Knobs", "Waterloo.": "Waterloo",
}
_TIE_RE = re.compile(r"\s*\((?:tie|Tie)\)\s*$")
_HS_RE = re.compile(r"\s+(?:H\.?\s?S\.?|High School)\s*$", re.I)


def canon_band(raw: str) -> str:
    """One printed entry -> canonical 'School, City' (city optional).
    NOTE: 'Mt. Vernon, Fortville' and 'Mount Vernon' (Posey Co.) are two
    different schools — school text is never re-spelled, only aliased."""
    n = norm_space(htmllib.unescape(raw))
    n = _TIE_RE.sub("", n)
    n = n.replace(" - ", ", ")            # current-page style -> history style
    school, city = (n.rsplit(",", 1) + [""])[:2] if "," in n else (n, "")
    school, city = norm_space(school), norm_space(city)
    school = _HS_RE.sub("", school)
    if school.endswith(".") and len(school.split()[-1]) > 3:
        school = school[:-1]              # 'Columbus North.' -> 'Columbus North'
    city = CITY_ALIASES.get(city, city)
    n = f"{school}, {city}" if city else school
    return SCHOOL_ALIASES.get(n, n)


def bare_city_map(names: set[str]) -> dict[str, str]:
    """Bare 'Penn' + a single city-qualified 'Penn, Mishawaka' in the corpus
    -> merge the bare form in. A bare school whose text matches multiple
    cities (none exist today) is left alone."""
    cities = defaultdict(set)
    for n in names:
        if "," in n:
            s, c = n.rsplit(",", 1)
            cities[norm_space(s)].add(norm_space(c))
    return {n: f"{n}, {next(iter(cities[n]))}"
            for n in names if "," not in n and len(cities.get(n, ())) == 1}


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

_YEAR_H2 = re.compile(r"<h2>(\d{4})</h2>")
_H3 = re.compile(r"<h3>(?:<u>)?([^<]+?)(?:</u>)?</h3>")
_ENTRY = re.compile(r"^(\d{1,2})\.\s*(.+?)\s*$")


def _entries(segment: str) -> list[tuple[int, str]]:
    """'1. School, City<br>...' lines -> [(place, raw name)]; anything that
    isn't a numbered line (footer junk after the last block) is ignored."""
    txt = re.sub(r"<br\s*/?>", "\n", segment, flags=re.I)
    txt = re.sub(r"<[^>]+>", "\n", txt)
    out = []
    for line in txt.split("\n"):
        m = _ENTRY.match(norm_space(htmllib.unescape(line)))
        if m:
            out.append((int(m.group(1)), m.group(2)))
    return out


def parse_history(html: str) -> dict[int, dict[str, list[tuple[int, str]]]]:
    """mbhistory.php -> {year: {class: [(place, raw name), ...]}}."""
    parts = _YEAR_H2.split(html)
    seasons: dict[int, dict] = {}
    for i in range(1, len(parts), 2):
        year, chunk = int(parts[i]), parts[i + 1]
        end = chunk.find("</table>")          # the last year runs into the footer
        if end >= 0 and _YEAR_H2.search(chunk) is None:
            chunk = chunk[:end]
        blocks = _H3.split(chunk)
        classes = {}
        for j in range(1, len(blocks), 2):
            cname = norm_space(blocks[j])
            if cname in CLASS_ORDER:
                ents = _entries(blocks[j + 1])
                if ents:
                    classes[cname] = ents
        if classes:
            seasons[year] = classes
    return seasons


def parse_current(html: str, *, scholastic: bool) -> tuple[int | None, dict]:
    """statembresults / statescholasticmbresults -> (year|None, {class: rows}).
    The scholastic page prints no year — the caller anchors it by overlap."""
    m = re.search(r"<h2>(\d{4})\s+ISSMA Marching Band State Finals</h2>", html)
    year = int(m.group(1)) if m else None
    blocks = _H3.split(html)
    classes = {}
    for j in range(1, len(blocks), 2):
        cname = norm_space(re.sub(r"</?u>", "", blocks[j]))
        if scholastic and cname in ("Class A", "Class B"):
            cname = "Scholastic " + cname[-1]
        if cname in CLASS_ORDER:
            ents = _entries(blocks[j + 1])
            if ents:
                classes[cname] = ents
    return year, classes


_SITE_HDR = re.compile(r"<b>([^<]+?)<br\s*/?>\s*([A-Z][a-z]+ \d{1,2}, \d{4})</b>", re.I)


def parse_upcoming(html: str) -> list[dict]:
    """mbinfo.php 'Marching Band Performance Sites' -> the coming fall's
    round-by-round schedule (event name, real date, host sites)."""
    i = html.find('id="sites"')
    j = html.find('id="schedules"')
    if i < 0 or j < 0:
        return []
    seg = html[i:j]
    heads = list(_SITE_HDR.finditer(seg))
    out = []
    for k, m in enumerate(heads):
        name = norm_space(htmllib.unescape(m.group(1)))
        try:
            d = datetime.strptime(m.group(2), "%B %d, %Y")
        except ValueError:
            continue
        body = seg[m.end():heads[k + 1].start() if k + 1 < len(heads) else len(seg)]
        txt = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
        txt = re.sub(r"<[^>]+>", "\n", txt)
        sites = [norm_space(htmllib.unescape(s)) for s in txt.split("\n") if norm_space(s)]
        out.append({"name": f"ISSMA {name}", "date": d.strftime("%Y-%m-%d"),
                    "date_display": d.strftime("%B %-d, %Y"),
                    "location": " · ".join(sites) if sites else None,
                    "url": f"{MBINFO_URL}#sites"})
    return out


# ---------------------------------------------------------------------------
# season events
# ---------------------------------------------------------------------------

def seq_ok(places: list[int]) -> bool:
    """Standard competition ranking: 1,2,2,4 legal; 1,3 or 2,1 not."""
    if not places or places[0] != 1:
        return False
    for i in range(1, len(places)):
        if places[i] not in (places[i - 1], i + 1):
            return False
    return True


def merge_current(seasons: dict, cur_year: int | None, cur: dict,
                  schol: dict, notes: list[str]) -> None:
    """Union the current-season pages into the history struct. The scholastic
    page has no printed year: it merges into whichever season's scholastic
    block it overlaps by name (>=3 names), else it is skipped — never guessed."""
    if cur_year:
        target = seasons.setdefault(cur_year, {})
        for cls, ents in cur.items():
            have = {canon_band(n) for _, n in target.get(cls, [])}
            extra = [(p, n) for p, n in ents if canon_band(n) not in have]
            if not target.get(cls):
                target[cls] = ents
                notes.append(f"{cur_year} {cls}: filled from statembresults.php")
            elif extra:
                target[cls] = sorted(target[cls] + extra, key=lambda e: e[0])
                notes.append(f"{cur_year} {cls}: +{len(extra)} row(s) from "
                             f"statembresults.php ({', '.join(n for _, n in extra)})")
    if schol:
        page_names = {canon_band(n) for ents in schol.values() for _, n in ents}
        best_y, best_hit = None, 0
        for y, classes in seasons.items():
            hist = {canon_band(n) for c in ("Scholastic A", "Scholastic B")
                    for _, n in classes.get(c, [])}
            hit = len(page_names & hist)
            if hit > best_hit:
                best_y, best_hit = y, hit
        if best_y is None or best_hit < 3:
            notes.append("scholastic finals page matched no season (new season "
                         "not in mbhistory yet?) — skipped")
            return
        target = seasons[best_y]
        for cls, ents in schol.items():
            have = {canon_band(n) for _, n in target.get(cls, [])}
            extra = [(p, n) for p, n in ents if canon_band(n) not in have]
            if extra:
                target[cls] = sorted(target.get(cls, []) + extra, key=lambda e: e[0])
                notes.append(f"{best_y} {cls}: +{len(extra)} row(s) from the "
                             f"scholastic finals page "
                             f"({', '.join(n for _, n in extra)})")


def build_events(seasons: dict, canon: dict[str, str], cur_year: int | None,
                 notes: list[str]) -> dict[int, list[dict]]:
    """Per year: an October Scholastic Class Finals event (2013+) and the
    November Open Class State Finals. Nominal sort dates — the display text
    never claims a day we don't know."""
    out: dict[int, list[dict]] = {}
    for year in sorted(seasons):
        classes = seasons[year]

        def results(cls: str) -> list[dict]:
            rows, seen = [], set()
            for place, raw in classes.get(cls, []):
                name = canon.get(canon_band(raw), canon_band(raw))
                if name in seen:
                    notes.append(f"{year} {cls}: duplicate row for {name} dropped")
                    continue
                seen.add(name)
                rows.append({"place": place, "corps": name, "score": None,
                             "placement": place})
            return rows

        evs = []
        schol = [{"class": c, "results": results(c)}
                 for c in ("Scholastic A", "Scholastic B") if classes.get(c)]
        if schol:
            evs.append({
                "name": "ISSMA Scholastic Class Finals",
                "date": f"{year}-10-15", "date_display": f"October {year}",
                "location": None,
                "url": SCHOL_URL if year == cur_year else HISTORY_URL,
                "source": "issma", "stage": "state", "champ": True,
                "has_recap": False, "classes": schol,
            })
        open_cls = [{"class": c, "results": results(c)}
                    for c in ("Class A", "Class B", "Class C", "Class D")
                    if classes.get(c)]
        if open_cls:
            evs.append({
                "name": "ISSMA Marching Band State Finals",
                "date": f"{year}-11-01", "date_display": f"November {year}",
                "location": "Lucas Oil Stadium, Indianapolis, IN" if year >= 2008 else None,
                "url": STATE_URL if year == cur_year else HISTORY_URL,
                "source": "issma", "stage": "state", "champ": True,
                "has_recap": False, "classes": open_cls,
            })
        if evs:
            out[year] = evs
    return out


def validate(season_files: dict[int, list]) -> list[str]:
    """Hard gates — any failure aborts the write."""
    errs = []
    years = {y for y in season_files if season_files[y]
             and any(c["results"] for ev in season_files[y] for c in ev["classes"])}
    for y in range(FIRST_YEAR, max(years) + 1):
        if y not in years and y not in COVID:
            errs.append(f"season {y} missing entirely")
    for year, evs in season_files.items():
        for ev in evs:
            for c in ev["classes"]:
                seen, places = set(), []
                for r in c["results"]:
                    if r["corps"] in seen:
                        errs.append(f"{year} {ev['name']} {c['class']}: duplicate {r['corps']}")
                    seen.add(r["corps"])
                    if r.get("score") is not None:
                        errs.append(f"{year} {ev['name']}: fabricated score on {r['corps']}")
                    if r.get("placement") != r.get("place") or not r["place"]:
                        errs.append(f"{year} {ev['name']} {c['class']}: bad placement on {r['corps']}")
                    places.append(r["place"])
                if c["results"] and not seq_ok(places):
                    errs.append(f"{year} {ev['name']} {c['class']}: ranks not "
                                f"standard-competition {places}")
            schol_ev = "Scholastic" in ev["name"]
            got = {c["class"] for c in ev["classes"]}
            for cls in CLASS_ORDER:
                if (CLASS_FIRST[cls] <= year and ("Scholastic" in cls) == schol_ev
                        and cls not in got):
                    errs.append(f"{year} {ev['name']}: class {cls} missing")
    return errs


# ---------------------------------------------------------------------------
# dataset assembly (contract: docs/usbands/data shape, placements flavor —
# the same null-score pattern the UIL ratings app already ships)
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    base = re.sub(r",.*$", "", name)
    h = int(hashlib.md5(f"{base}|hue".encode()).hexdigest()[:8], 16) % 360
    c1, c2 = f"hsl({h},55%,30%)", f"hsl({(h + 42) % 360},75%,52%)"
    words = [w for w in re.findall(r"[A-Za-z0-9]+", base) if w.upper() not in ("HS", "THE", "OF")]
    ini = "".join(w[0] for w in words[:2]).upper() or base[:2].upper()
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
           f"<stop offset='0' stop-color='{c1}'/><stop offset='1' stop-color='{c2}'/>"
           "</linearGradient></defs>"
           "<rect width='64' height='64' rx='14' fill='url(#g)'/>"
           f"<text x='32' y='42' font-family='system-ui,sans-serif' font-size='27' "
           f"font-weight='800' fill='#fff' text-anchor='middle'>{ini}</text></svg>")
    return "data:image/svg+xml;utf8," + quote(svg, safe="") + "#logo.svg"


def assemble(season_files: dict[int, list], upcoming: list[dict],
             updated: str) -> None:
    years = sorted(y for y in season_files
                   if any(c["results"] for ev in season_files[y] for c in ev["classes"]))
    latest = years[-1]
    (DOCS / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS / "corps").mkdir(exist_ok=True)
    (DOCS / "db").mkdir(exist_ok=True)

    # the coming fall's schedule joins the season map as future events
    up_year = None
    if upcoming:
        up_year = int(upcoming[0]["date"][:4])
        if up_year not in season_files:
            season_files[up_year] = [
                {"name": u["name"], "date": u["date"], "date_display": u["date_display"],
                 "location": u["location"], "url": u["url"], "source": "issma",
                 "has_recap": False, "classes": []} for u in upcoming]

    perfs: dict[str, list[dict]] = defaultdict(list)
    champions: dict[str, dict] = {}
    db_rows = []
    for year in years:
        for ev in season_files[year]:
            for c in ev["classes"]:
                for r in c["results"]:
                    perfs[r["corps"]].append(
                        {"y": year, "d": ev["date"], "ev": ev["name"],
                         "cls": c["class"], "p": r["place"], "s": None,
                         "placement": r["placement"], "champ": True})
                    db_rows.append([year, ev["date"], ev["name"], r["corps"],
                                    c["class"], r["place"], None])
                if c["results"] and c["results"][0]["placement"] == 1:
                    champions.setdefault(str(year), {})[c["class"]] = {
                        "corps": c["results"][0]["corps"], "score": None}

    # ---- standings: the most recent State Finals placements per class
    standings = {}
    for cls in CLASS_ORDER:
        rows = []
        for name, hist in perfs.items():
            season = [p for p in hist if p["y"] == latest and p["cls"] == cls]
            if not season:
                continue
            p = season[-1]
            rows.append({"corps": name, "score": None, "placement": p["placement"],
                         "date": p["d"], "event": p["ev"],
                         "high": None, "high_event": None, "high_date": None,
                         "prev_score": None, "delta": None, "outings": len(season),
                         "trend": [[p["d"], p["placement"]]]})
        if not rows:
            continue
        rows.sort(key=lambda r: (r["placement"], r["corps"].casefold()))
        for i, r in enumerate(rows):
            r["rank"] = i + 1
        standings[cls] = {"rows": rows, "movers": [], "battles": []}

    # ---- per-band index / files / profiles
    idx, profiles = [], {}
    titles_by_band: dict[str, list] = defaultdict(list)
    for y, by_cls in champions.items():
        for cls, w in by_cls.items():
            titles_by_band[w["corps"]].append(f"{y} ({cls})")
    slugs = {}
    for name in sorted(perfs, key=str.casefold):
        plist = sorted(perfs[name], key=lambda p: (p["y"], p["d"]))
        yrs = sorted({p["y"] for p in plist})
        series = []
        for y in yrs:
            best = min((p for p in plist if p["y"] == y), key=lambda p: p["placement"])
            series.append([y, best["placement"], best["cls"]])
        sl = base = slugify(name)
        n = 2
        while slugs.get(sl) not in (None, name):
            sl, n = f"{base}-{n}", n + 1
        slugs[sl] = name
        placements = [p["placement"] for p in plist]
        idx.append({"name": name, "slug": sl, "first": yrs[0], "last": yrs[-1],
                    "seasons": len(yrs), "best": None,
                    "best_placement": min(placements), "n": len(plist),
                    "series": series})
        (DOCS / "corps" / f"{sl}.json").write_text(
            json.dumps({"name": name, "performances": plist}, ensure_ascii=False))
        cls_now = series[-1][2]
        titles = sorted(titles_by_band.get(name, []))
        n_finals = len({p["y"] for p in plist})
        bits = [f"{name} marches in ISSMA {cls_now}."]
        if titles:
            bits.append("State champion: " + ", ".join(titles) + ".")
        bits.append(f"{n_finals} State Finals appearance{'s' if n_finals != 1 else ''} "
                    f"on record, {yrs[0]}–{yrs[-1]}. Public ISSMA placement history; "
                    "scores are directors-only.")
        profiles[sl] = {"title": name, "img": monogram(name), "summary": " ".join(bits)}

    # ---- records: intentionally empty — ISSMA publishes no point scores
    records = {cls: {"top": [], "finals": {}} for cls in CLASS_ORDER}

    by_decade: dict[str, list] = defaultdict(list)
    for row in db_rows:
        by_decade[f"{row[0] // 10 * 10}s"].append(row)

    # stale demo/previous files must not survive a rebuild
    keep_years = set(years) | ({up_year} if up_year else set())
    for p in (DOCS / "seasons").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in keep_years:
            p.unlink()
    for p in (DOCS / "corps").glob("*.json"):
        if p.stem not in slugs:
            p.unlink()
    for p in (DOCS / "db").glob("perfs_*.json"):
        if p.stem.replace("perfs_", "") not in by_decade:
            p.unlink()

    w = lambda rel, obj: (DOCS / rel).write_text(json.dumps(obj, ensure_ascii=False))
    w("meta.json", {
        "updated": updated,
        "seasons": [{"year": y, "events": len(season_files[y])}
                    for y in sorted(keep_years)],
        "series_kind": "placement",
        "score_note": ("ISSMA publishes State Finals placements only — scores "
                       "live behind its Directors-Only login. Every score field "
                       "in this dataset is null by design; \"placement\" is the "
                       "published State Finals ordinal."),
    })
    w("rankings.json", {"generated": updated, "season": latest,
                        "standings": standings, "recent_events": []})
    for y in sorted(keep_years):
        w(f"seasons/{y}.json", season_files[y])
    w("upcoming.json", upcoming)
    w("corps_index.json", idx)
    w("profiles.json", profiles)
    w("champions.json", champions)
    w("records.json", records)
    w("db/index.json", [{"decade": d, "rows": len(rows)} for d, rows in sorted(by_decade.items())])
    for d, rows in by_decade.items():
        w(f"db/perfs_{d}.json", sorted(rows, key=lambda r: (r[0], r[1], r[2], r[4])))
    (DOCS / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"issma: wrote {sum(len(season_files[y]) for y in years)} events across "
        f"{years[0]}–{years[-1]}, {len(db_rows)} placement rows, {len(idx)} bands, "
        f"{sum(len(s['rows']) for s in standings.values())} standings rows"
        + (f", {len(upcoming)} upcoming {up_year} shows" if upcoming else ""))


# ---------------------------------------------------------------------------
# ingest driver
# ---------------------------------------------------------------------------

def ingest(*, force: bool = True) -> int:
    notes: list[str] = []
    hist_html = fetch(HISTORY_URL, force=force)
    if not hist_html:
        log("issma ingest FAILED: mbhistory.php unreachable")
        return 1
    seasons = parse_history(hist_html)
    if len(seasons) < 50:
        log(f"issma ingest FAILED: only {len(seasons)} seasons parsed from mbhistory.php")
        return 1

    cur_html = fetch(STATE_URL, force=force) or ""
    schol_html = fetch(SCHOL_URL, force=force) or ""
    cur_year, cur = parse_current(cur_html, scholastic=False)
    _, schol = parse_current(schol_html, scholastic=True)
    merge_current(seasons, cur_year, cur, schol, notes)

    # canonical identities need the whole corpus (bare-name -> city merges)
    all_names = {canon_band(n) for classes in seasons.values()
                 for ents in classes.values() for _, n in ents}
    canon = bare_city_map(all_names)
    for bare, full in sorted(canon.items()):
        notes.append(f"identity merge: '{bare}' -> '{full}'")

    season_files = build_events(seasons, canon, cur_year, notes)

    errs = validate(season_files)
    if errs:
        log(f"issma ingest FAILED validation ({len(errs)} problems) — refusing to write")
        for e in errs[:20]:
            log(f"  ! {e}")
        return 1

    upcoming = parse_upcoming(fetch(MBINFO_URL, force=force) or "")
    latest = max(season_files)
    upcoming = [u for u in upcoming if int(u["date"][:4]) > latest]

    n_rows = sum(len(c["results"]) for evs in season_files.values()
                 for ev in evs for c in ev["classes"])
    if n_rows < 1900:
        log(f"issma ingest FAILED: only {n_rows} placement rows — refusing to write")
        return 1

    DOCS.mkdir(parents=True, exist_ok=True)
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    assemble(season_files, upcoming, updated)
    for note in notes:
        log(f"  note: {note}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cached", action="store_true",
                    help="dev only: reuse the on-disk fetch cache instead of refetching")
    args = ap.parse_args()
    return ingest(force=not args.cached)


if __name__ == "__main__":
    sys.exit(main())
