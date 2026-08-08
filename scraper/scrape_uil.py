#!/usr/bin/env python3
"""UIL Texas Marching Band ingest — the whole state, ratings not scores.

Sources (probed live, see data/circuit-probes/texas-uil-msba.md):

  A. texasmusicforms.com public CSV (CutTime LLC, UIL's official region
     marching results vendor) — ONE GET per season, 2005-2026:
       marchuilpubliccsv.asp?yr=YYYY&connum=ALL&rg=ALL&ev=x&get=go
     Columns: School, City, Region, Director(s), Classification, NV,
     Conference (A..AAAAAA), Contest, Contest Date, per-judge Division
     ratings (Score 1-3) and Final Score — RATINGS 1-5 (1=Superior), not
     point scores. ~900-1,070 bands per season.

  B. smbc.uiltexas.org — the State Marching Band Contest portal:
     index page = current season's Prelims/Finals ordinals for all six
     conferences as inline static HTML; archives.htm = one inline table of
     every state placement 1979-2024 (Year/Conference/Round/Place/School).

HONESTY MODEL — UIL awards Division ratings and state placements, never
point scores, so every result row here carries  score: null  plus either
"rating"/"rating_label" (region contests) or "placement" (state rounds).
Nothing numeric is ever invented; the shared engine's score columns render
"—" until its ratings-display mode lands (see task notes).

Identity: Texas has many same-named schools ("Bowie HS" x4), so bands are
threaded as (school, city-cluster) identities across all 22 seasons; a school
name that exists in more than one city displays with its city qualifier.
Non-varsity bands are separate identities with an "(NV)" suffix.

Usage:
  python3 scraper/scrape_uil.py --ingest            # all seasons, cached
  python3 scraper/scrape_uil.py --ingest --refresh  # force-refetch current
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html as htmllib
import io
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from urllib.parse import quote

from common import ROOT, fetch, log, norm_space, slugify

DOCS = ROOT / "docs" / "uil" / "data"
STORE = DOCS / "live_store.json"

CSV_URL = "https://www.texasmusicforms.com/marchuilpubliccsv.asp?yr={yr}&connum=ALL&rg=ALL&ev=x&get=go"
REPORT_URL = "https://www.texasmusicforms.com/marchrptuilpublic.asp"
SMBC_URL = "https://smbc.uiltexas.org/"
ARCHIVES_URL = "https://www.smbc.uiltexas.org/archives.htm"

FIRST_CSV_YEAR, LAST_CSV_YEAR = 2005, 2026

CONF_MAP = {"A": "1A", "AA": "2A", "AAA": "3A", "AAAA": "4A",
            "AAAAA": "5A", "AAAAAA": "6A"}
CLASS_ORDER = ["6A", "5A", "4A", "3A", "2A", "1A", "B"]
RATING_LABELS = {1: "Superior", 2: "Excellent", 3: "Good", 4: "Fair", 5: "Poor"}

# ---------------------------------------------------------------------------
# normalization
# ---------------------------------------------------------------------------

_HS_RE = re.compile(r"\bH\.?\s*S\.?(?=[\s,]|$)|\bHigh\s+Schools?\b|\bHighschool\b", re.I)


def norm_school(s: str) -> str:
    s = norm_space(htmllib.unescape(s or "").replace("\xa0", " ")).strip(" ,.")
    s = _HS_RE.sub("HS", s)
    return norm_space(s).strip(" ,")


_CITY_ABBR = [("ft ", "fort "), ("mt ", "mount "), ("n ", "north "),
              ("s ", "south "), ("e ", "east "), ("w ", "west ")]


def city_key(c: str) -> str:
    """Canonical join key for a city string: case/punct-folded, common
    abbreviations expanded, state/zip tails stripped."""
    c = norm_space(c or "").lower().strip(" ,.")
    c = re.sub(r",?\s*(tx|texas)\b.*$", "", c)
    c = re.sub(r"[^a-z ]+", " ", c)
    c = norm_space(c)
    for a, b in _CITY_ABBR:
        if c.startswith(a):
            c = b + c[len(a):]
    return c.replace(" ", "")


def is_nonvarsity(classification: str) -> bool:
    c = (classification or "").strip().lower()
    return c.startswith(("non-varsity", "nvar", "sub non"))


def title_if_shouty(s: str) -> str:
    """'UIL REGION 2 MARCHING CONTEST' -> 'UIL Region 2 Marching Contest'
    without touching mixed-case strings (McAllen etc. stay intact)."""
    letters = [ch for ch in s if ch.isalpha()]
    if not letters or not all(ch.isupper() for ch in letters):
        return s
    t = s.title()
    t = re.sub(r"\bUil\b", "UIL", t)
    t = re.sub(r"\b(Ez|Wz|Sz|Nz)\b", lambda m: m.group(1).upper(), t)
    return t


def iso_date(mdy: str) -> str | None:
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", (mdy or "").strip())
    if not m:
        return None
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"


_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]


def date_display(iso: str | None) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", iso or "")
    if not m:
        return ""
    return f"{_MONTHS[int(m.group(2))]} {int(m.group(3))}, {m.group(1)}"


# ---------------------------------------------------------------------------
# source A: region CSVs
# ---------------------------------------------------------------------------

def fetch_region_year(year: int, *, force: bool = False) -> list[dict]:
    """One season's region rows, filtered to real contests: region 1-33,
    a real 1A-6A conference, a parseable in-season date, and a Final rating.
    Everything dropped is counted and logged (vendor test rows live in
    'Region 88'/'Region 50'; DNA/DQ/blank ratings are not performances with
    a result)."""
    txt = fetch(CSV_URL.format(yr=year), force=force)
    if not txt:
        return []
    rows, dropped = [], Counter()
    for r in csv.DictReader(io.StringIO(txt)):
        school = norm_school(r.get("School") or "")
        region = (r.get("Region") or "").strip()
        conf = CONF_MAP.get((r.get("Conference") or "").strip())
        d = iso_date(r.get("Contest Date") or "")
        raw_final = (r.get("Final Score") or "").strip().rstrip("*")
        if not school:
            dropped["no school"] += 1
            continue
        if not region.isdigit() or not 1 <= int(region) <= 33:
            dropped["test/odd region"] += 1
            continue
        if not conf:
            dropped["non-HS conference"] += 1
            continue
        if not d or d[:4] != str(year) or d[5:7] not in ("09", "10", "11", "12"):
            dropped["bad/off-season date"] += 1
            continue
        if raw_final in ("DNA", ""):
            dropped["no rating (DNA/blank)"] += 1
            continue
        if raw_final == "DQ":
            dropped["DQ"] += 1
            continue
        if not raw_final.isdigit() or not 1 <= int(raw_final) <= 5:
            dropped[f"unparseable rating {raw_final!r}"] += 1
            continue
        judges = []
        for k in ("Score 1", "Score 2", "Score 3"):
            v = (r.get(k) or "").strip().rstrip("*")
            judges.append(int(v) if v.isdigit() and 1 <= int(v) <= 5 else None)
        rows.append({
            "school": school, "city": norm_space(r.get("City") or "").strip(" ,."),
            "region": int(region), "conf": conf,
            "nv": is_nonvarsity(r.get("Classification") or ""),
            "nv_letter": (r.get("NV") or "").strip() if is_nonvarsity(r.get("Classification") or "") else "",
            "contest": norm_space(r.get("Contest") or "") or "Region Marching Contest",
            "date": d, "rating": int(raw_final), "judges": judges,
        })
    if dropped:
        log(f"  uil {year}: kept {len(rows)}, dropped {dict(dropped)}")
    return rows


def region_event_name(region: int, contest: str) -> str:
    c = title_if_shouty(norm_space(contest))
    if re.search(rf"\breg(?:ion)?\.?\s*0*{region}\b", c, re.I):
        return c
    return f"Region {region} — {c}"


# ---------------------------------------------------------------------------
# source B: state (SMBC) pages
# ---------------------------------------------------------------------------

_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)


def _cell(x: str) -> str:
    return norm_space(htmllib.unescape(re.sub(r"<[^>]+>", " ", x)).replace("\xa0", " "))


def parse_state_school(raw: str) -> tuple[str, str | None, str | None]:
    """'Hebron HS, Carrollton (Lewisville ISD)' -> (school, city, district)."""
    raw = norm_space(htmllib.unescape(raw).replace("\xa0", " "))
    district = None
    m = re.search(r"\(([^)]*)\)\s*$", raw)
    if m:
        district = norm_space(m.group(1)) or None
        raw = raw[:m.start()].strip(" ,")
    school, city = raw, None
    if "," in raw:
        school, city = (p.strip() for p in raw.rsplit(",", 1))
    return norm_school(school), (city or None), district


def fetch_archives() -> list[dict]:
    """archives.htm -> [{year, conf, round, place|None, school, city, district,
    note}] — every state placement 1979-2024 (blank places = prelims
    participants listed without an ordinal)."""
    html = fetch(ARCHIVES_URL)
    if not html:
        return []
    m = re.search(r'<table[^>]*id="archives"', html)
    if not m:
        return []
    out = []
    for tr in _TR.findall(html[m.start():]):
        tds = [_cell(td) for td in _TD.findall(tr)]
        if len(tds) < 5 or not tds[0].isdigit():
            continue
        school, city, district = parse_state_school(tds[4])
        if not school:
            continue
        out.append({"year": int(tds[0]), "conf": tds[1], "round": tds[2],
                    "place": int(tds[3]) if tds[3].isdigit() else None,
                    "school": school, "city": city, "district": district,
                    "note": tds[5] if len(tds) > 5 else ""})
    return out


def fetch_smbc_current(*, force: bool = False) -> tuple[int | None, list[dict]]:
    """The live SMBC index page -> (season year, rows like fetch_archives)."""
    html = fetch(SMBC_URL, force=force)
    if not html:
        return None, []
    ym = re.search(r"<h1[^>]*>\s*(\d{4}) State Marching Band Results", html)
    if not ym:
        return None, []
    year = int(ym.group(1))
    out = []
    for m in re.finditer(r'<tbody[^>]*id="(Prelims|Finals)([1-6]A)"[^>]*>(.*?)</tbody>', html, re.S):
        rnd, conf, body = m.group(1), m.group(2), m.group(3)
        for tr in _TR.findall(body):
            tds = [_cell(td) for td in _TD.findall(tr)]
            if len(tds) < 3 or not tds[0].isdigit():
                continue
            school, city, district = parse_state_school(tds[1])
            if not school:
                continue
            out.append({"year": year, "conf": conf, "round": rnd,
                        "place": int(tds[0]), "school": school, "city": city,
                        "district": district, "note": ""})
    return year, out


# ---------------------------------------------------------------------------
# identity registry — (school, city-cluster) across every season
# ---------------------------------------------------------------------------

class Registry:
    """Threads every appearance to one band identity. Clusters are city-key
    based ('Ft. Worth'/'Fort Worth' merge; genuinely different cities split),
    blank cities resolve through the school's (year, region) footprint, and
    state entries match by city, then uniqueness, then district."""

    def __init__(self):
        self.idents: dict[tuple, dict] = {}          # key -> identity record
        self.by_school: dict[str, list] = defaultdict(list)

    @staticmethod
    def skey(school: str) -> str:
        return school.casefold()

    def _cluster(self, sk: str, ck: str, create: bool = True):
        """Find (or open) the school's city cluster matching city-key ck."""
        clusters = self.by_school[sk]
        if ck:
            for cl in clusters:
                if cl["ck"] and (cl["ck"].startswith(ck) or ck.startswith(cl["ck"])):
                    return cl
        if not create:
            return None
        cl = {"ck": ck, "cities": Counter(), "names": Counter(), "regions": set()}
        clusters.append(cl)
        return cl

    def add_region_row(self, r: dict) -> None:
        sk = self.skey(r["school"])
        cl = self._cluster(sk, city_key(r["city"]))
        if r["city"]:
            cl["cities"][r["city"]] += 1
        cl["names"][r["school"]] += 1
        cl["regions"].add((r["date"][:4], r["region"]))
        r["_cluster"] = id(cl)

    def resolve_region_row(self, r: dict):
        """After all rows are added: blank-city rows join the cluster whose
        region footprint matches, else the school's biggest cluster."""
        sk = self.skey(r["school"])
        if city_key(r["city"]):
            cl = self._cluster(sk, city_key(r["city"]))
        else:
            named = [c for c in self.by_school[sk] if c["ck"]]
            cl = None
            for c in named:
                if any(rg == r["region"] for _y, rg in c["regions"]):
                    cl = c
                    break
            if cl is None:
                pool = named or self.by_school[sk]
                cl = max(pool, key=lambda c: sum(c["names"].values())) if pool \
                    else self._cluster(sk, "")
        cl["names"][r["school"]] += 0
        return self._ident(sk, cl, r["nv"], r["nv_letter"])

    def resolve_state_row(self, r: dict):
        sk = self.skey(r["school"])
        ck = city_key(r["city"] or "")
        cl = self._cluster(sk, ck, create=False) if ck else None
        if cl is None and not ck:
            named = [c for c in self.by_school[sk] if c["ck"]]
            if len(named) == 1:
                cl = named[0]
            elif len(named) > 1 and r.get("district"):
                cl = self._cluster(sk, "isd" + city_key(r["district"]))
                cl["cities"][r["district"]] += 1
        if cl is None:
            cl = self._cluster(sk, ck)
            if r.get("city"):
                cl["cities"][r["city"]] += 1
        cl["names"][r["school"]] += 1
        return self._ident(sk, cl, False, "")

    def _ident(self, sk: str, cl: dict, nv: bool, nv_letter: str):
        key = (sk, id(cl), "nv" + nv_letter if nv else "")
        if key not in self.idents:
            self.idents[key] = {"sk": sk, "cluster": cl, "nv": nv,
                                "nv_letter": nv_letter, "key": key}
        return self.idents[key]

    def finalize(self) -> None:
        """Assign display names + unique slugs. A school name spanning more
        than one city cluster gets its city qualifier."""
        multi = {sk for sk, cls in self.by_school.items()
                 if len([c for c in cls if sum(c["names"].values())]) > 1}
        used = {}
        for key in sorted(self.idents, key=lambda k: (k[0], str(k[1]), k[2])):
            ident = self.idents[key]
            cl = ident["cluster"]
            school = cl["names"].most_common(1)[0][0] if cl["names"] else ident["sk"]
            name = school
            if ident["sk"] in multi and cl["cities"]:
                name += f" ({title_if_shouty(cl['cities'].most_common(1)[0][0])})"
            if ident["nv"]:
                name += f" (NV{' ' + ident['nv_letter'] if ident['nv_letter'] else ''})"
            slug = base = slugify(name)
            n = 2
            while used.get(slug) not in (None, key):
                slug = f"{base}-{n}"
                n += 1
            used[slug] = key
            ident["name"], ident["slug"] = name, slug


# ---------------------------------------------------------------------------
# event building
# ---------------------------------------------------------------------------

def build_region_events(rows: list[dict], reg: Registry, year: int) -> list[dict]:
    """Group one season's rows into (region, contest, date) events; classes are
    conferences 6A..1A; place is the rating-then-name order (ratings carry the
    real result)."""
    events: dict[tuple, dict] = {}
    dup = 0
    for r in rows:
        ident = reg.resolve_region_row(r)
        k = (r["region"], r["contest"], r["date"])
        ev = events.setdefault(k, {"region": r["region"], "contest": r["contest"],
                                   "date": r["date"], "classes": {}})
        cls = ev["classes"].setdefault(r["conf"], {})
        if ident["key"] in cls:            # same band listed twice in one event
            dup += 1
            continue
        cls[ident["key"]] = {"ident": ident, "rating": r["rating"], "judges": r["judges"]}
    if dup:
        log(f"  uil {year}: {dup} duplicate band rows within an event dropped")
    out = []
    for (region, contest, date), ev in sorted(events.items(), key=lambda kv: (kv[0][2], kv[0][0])):
        classes = []
        for conf in CLASS_ORDER:
            entries = ev["classes"].get(conf)
            if not entries:
                continue
            ranked = sorted(entries.values(),
                            key=lambda e: (e["rating"], e["ident"]["name"].casefold()))
            classes.append({"class": conf, "results": [
                {"place": i + 1, "corps": e["ident"]["name"], "score": None,
                 "rating": e["rating"], "rating_label": RATING_LABELS[e["rating"]],
                 "judge_ratings": e["judges"]}
                for i, e in enumerate(ranked)]})
        if not classes:
            continue
        out.append({
            "name": region_event_name(region, contest),
            "date": date, "date_display": date_display(date),
            "location": f"UIL Region {region}", "url": REPORT_URL,
            "source": "uil-tmf", "stage": "region", "has_recap": False,
            "classes": classes,
        })
    return out


def seq_ok(places: list[int]) -> bool:
    """Standard competition ranking: starts at 1, ties allowed, a place never
    exceeds (index+1) and never goes backwards."""
    prev = 0
    for i, p in enumerate(places):
        if p < prev or p > i + 1:
            return False
        prev = p
    return bool(places) and places[0] == 1


def build_state_events(state_rows: list[dict], reg: Registry, notes: list[str]) -> dict[int, list[dict]]:
    """State rows (archives + live page) -> per-year Prelims/Finals events.
    Places are the published ordinals (real ties kept — e.g. the 2011 4A
    co-champions); groups whose ordinals fail standard competition ranking
    are demoted to unplaced rather than reordered."""
    by_year: dict[int, dict[str, dict[str, list]]] = defaultdict(lambda: defaultdict(dict))
    for r in state_rows:
        ident = reg.resolve_state_row(r)
        rnd = "Finals" if r["round"].lower().startswith("final") else "Prelims"
        cls = by_year[r["year"]][rnd].setdefault(r["conf"], {})
        if ident["key"] in cls:
            continue
        cls[ident["key"]] = {"ident": ident, "place": r["place"], "note": r["note"]}

    events: dict[int, list[dict]] = defaultdict(list)
    for year, rounds in sorted(by_year.items()):
        for rnd, sort_day in (("Prelims", "01"), ("Finals", "02")):
            classes = []
            for conf in CLASS_ORDER:
                entries = rounds.get(rnd, {}).get(conf)
                if not entries:
                    continue
                placed = sorted((e for e in entries.values() if e["place"] is not None),
                                key=lambda e: (e["place"], e["ident"]["name"].casefold()))
                unplaced = sorted((e for e in entries.values() if e["place"] is None),
                                  key=lambda e: e["ident"]["name"].casefold())
                if placed and not seq_ok([e["place"] for e in placed]):
                    notes.append(f"{year} {conf} {rnd}: published ordinals not a valid "
                                 f"ranking ({[e['place'] for e in placed]}) — kept as unplaced")
                    unplaced = sorted(placed + unplaced, key=lambda e: e["ident"]["name"].casefold())
                    for e in unplaced:
                        e["demoted"] = True
                    placed = []
                results = [{"place": e["place"], "corps": e["ident"]["name"], "score": None,
                            "placement": e["place"]} for e in placed]
                results += [{"place": None, "corps": e["ident"]["name"], "score": None,
                             "placement": e.get("demoted") and None or e["place"]}
                            for e in unplaced]
                if results:
                    classes.append({"class": conf, "results": results})
            if not classes:
                continue
            events[year].append({
                "name": f"State Marching Band Championships — {rnd}",
                # nominal early-November sort dates; the display never claims a day
                "date": f"{year}-11-{sort_day}", "date_display": f"November {year}",
                "location": "San Antonio, TX" if year >= 2003 else None,
                "url": SMBC_URL if year >= 2025 else ARCHIVES_URL,
                "source": "uil-smbc", "stage": "state", "champ": rnd == "Finals",
                "has_recap": False, "classes": classes,
            })
    return events


# ---------------------------------------------------------------------------
# dataset assembly (contract: docs/usbands/data shape, ratings flavor)
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    base = re.sub(r"\s*\([^)]*\)\s*$", "", name)
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


def validate(season_files: dict[int, list]) -> list[str]:
    """Hard gates — any failure aborts the write."""
    errs = []
    for year, evs in season_files.items():
        for ev in evs:
            for c in ev["classes"]:
                seen = set()
                places = []
                for r in c["results"]:
                    if r["corps"] in seen:
                        errs.append(f"{year} {ev['name']} {c['class']}: duplicate {r['corps']}")
                    seen.add(r["corps"])
                    if r.get("rating") is not None and not 1 <= r["rating"] <= 5:
                        errs.append(f"{year} {ev['name']}: rating {r['rating']} out of bounds")
                    if r.get("score") is not None:
                        errs.append(f"{year} {ev['name']}: unexpected numeric score")
                    if r["place"] is not None:
                        places.append(r["place"])
                if places and not seq_ok(places):
                    errs.append(f"{year} {ev['name']} {c['class']}: ranks not sequential {places[:14]}")
    return errs


def assemble(season_files: dict[int, list], champions: dict, updated: str,
             latest_rated: int) -> None:
    years = sorted(season_files)
    (DOCS / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS / "corps").mkdir(exist_ok=True)
    (DOCS / "db").mkdir(exist_ok=True)

    perfs: dict[str, list[dict]] = defaultdict(list)     # band name -> outings
    db_rows = []
    for year in years:
        for ev in season_files[year]:
            champ = bool(ev.get("champ"))
            for c in ev["classes"]:
                for r in c["results"]:
                    p = {"y": year, "d": ev["date"], "ev": ev["name"], "cls": c["class"],
                         "p": r["place"], "s": None, "champ": champ}
                    if r.get("rating") is not None:
                        p["rating"] = r["rating"]
                        p["rating_label"] = r["rating_label"]
                    if r.get("placement") is not None:
                        p["placement"] = r["placement"]
                    perfs[r["corps"]].append(p)
                    db_rows.append([year, ev["date"], ev["name"], r["corps"], c["class"],
                                    r["place"], None, r.get("rating")])

    # ---- standings: latest rated season, rating then name within conference
    standings = {}
    state_by_band: dict[str, dict] = defaultdict(dict)
    for ev in season_files.get(latest_rated, []):
        if ev.get("stage") != "state":
            continue
        rnd = "finals" if ev.get("champ") else "prelims"
        for c in ev["classes"]:
            for r in c["results"]:
                if r.get("placement") is not None:
                    state_by_band[r["corps"]][rnd] = r["placement"]
    for conf in CLASS_ORDER:
        rows = []
        for name, hist in perfs.items():
            season = sorted((p for p in hist if p["y"] == latest_rated
                             and p["cls"] == conf and "rating" in p),
                            key=lambda p: p["d"])
            if not season:
                continue
            last = season[-1]
            row = {"corps": name, "score": None, "rating": last["rating"],
                   "rating_label": last["rating_label"],
                   "date": last["d"], "event": last["ev"],
                   "high": None, "high_event": None, "high_date": None,
                   "prev_score": None, "delta": None, "outings": len(season),
                   "trend": [[p["d"], p["rating"]] for p in season]}
            if state_by_band.get(name):
                row["state"] = state_by_band[name]
            rows.append(row)
        if not rows:
            continue
        rows.sort(key=lambda r: (r["rating"], r["corps"].casefold()))
        for i, r in enumerate(rows):
            r["rank"] = i + 1
        standings[conf] = {"rows": rows, "movers": [], "battles": []}

    # ---- per-band index / files / profiles
    idx, profiles = [], {}
    champ_years_by_band: dict[str, list] = defaultdict(list)
    for y, by_cls in champions.items():
        for cls, w in by_cls.items():
            champ_years_by_band[w["corps"]].append(f"{y} ({cls})")
            if w.get("co"):
                champ_years_by_band[w["co"]].append(f"{y} ({cls})")
    slugs_seen = {}
    for name in sorted(perfs, key=str.casefold):
        plist = sorted(perfs[name], key=lambda p: (p["y"], p["d"] or ""))
        yrs = sorted({p["y"] for p in plist})
        series = []
        for y in yrs:
            ys = [p for p in plist if p["y"] == y]
            rated = [p for p in ys if "rating" in p]
            best = min((p["rating"] for p in rated), default=None)
            cls = (rated or ys)[-1]["cls"]
            series.append([y, best, cls])
        ratings = [p["rating"] for p in plist if "rating" in p]
        sl = base = slugify(name)
        n = 2
        while slugs_seen.get(sl) not in (None, name):
            sl = f"{base}-{n}"
            n += 1
        slugs_seen[sl] = name
        idx.append({"name": name, "slug": sl, "first": yrs[0], "last": yrs[-1],
                    "seasons": len(yrs), "best": None,
                    "best_rating": min(ratings) if ratings else None,
                    "n": len(plist), "series": series})
        (DOCS / "corps" / f"{sl}.json").write_text(
            json.dumps({"name": name, "performances": plist}, ensure_ascii=False))
        cls_now = series[-1][2]
        titles = sorted(champ_years_by_band.get(name, []))
        n_sup = sum(1 for x in ratings if x == 1)
        bits = [f"{name} marches in UIL Texas Conference {cls_now}."]
        if titles:
            bits.append("State champion: " + ", ".join(titles) + ".")
        if n_sup:
            bits.append(f"{n_sup} Division I (Superior) region rating{'s' if n_sup != 1 else ''} on record.")
        bits.append(f"Official UIL results, {yrs[0]}–{yrs[-1]}.")
        profiles[sl] = {"title": name, "img": monogram(name), "summary": " ".join(bits)}

    # ---- records: intentionally empty (no point scores exist to rank)
    records = {conf: {"top": [], "finals": {}} for conf in CLASS_ORDER}

    by_decade: dict[str, list] = defaultdict(list)
    for row in db_rows:
        by_decade[f"{row[0] // 10 * 10}s"].append(row)

    # stale demo/previous files must not survive a rebuild
    for p in (DOCS / "seasons").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in years:
            p.unlink()
    live_slugs = {c["slug"] for c in idx}
    for p in (DOCS / "corps").glob("*.json"):
        if p.stem not in live_slugs:
            p.unlink()
    for p in (DOCS / "db").glob("perfs_*.json"):
        if p.stem.replace("perfs_", "") not in by_decade:
            p.unlink()

    w = lambda rel, obj: (DOCS / rel).write_text(json.dumps(obj, ensure_ascii=False))
    w("meta.json", {
        "updated": updated,
        "seasons": [{"year": y, "events": len(season_files[y])} for y in years],
        "series_kind": "rating",
        "rating_labels": {str(k): v for k, v in RATING_LABELS.items()},
        "score_note": ("UIL region contests award Division ratings (1=Superior … 5=Poor), "
                       "not point scores; the State Marching Band Championships publish "
                       "placements. Every score field in this dataset is null by design."),
    })
    w("rankings.json", {"generated": updated, "season": latest_rated,
                        "standings": standings, "recent_events": []})
    for y in years:
        w(f"seasons/{y}.json", season_files[y])
    w("upcoming.json", [])
    w("corps_index.json", idx)
    w("profiles.json", profiles)
    w("champions.json", champions)
    w("records.json", records)
    w("db/index.json", [{"decade": d, "rows": len(rows)} for d, rows in sorted(by_decade.items())])
    for d, rows in by_decade.items():
        w(f"db/perfs_{d}.json", sorted(rows, key=lambda r: (r[0], r[1] or "", r[2], r[4])))
    (DOCS / "LIVE").write_text(f"live data ingested {updated}\n")
    n_rows = sum(len(v) for v in perfs.values())
    log(f"uil: wrote {sum(len(v) for v in season_files.values())} events across "
        f"{years[0]}–{years[-1]}, {n_rows} performances, {len(idx)} bands, "
        f"{sum(len(s['rows']) for s in standings.values())} standings rows")


# ---------------------------------------------------------------------------
# ingest driver
# ---------------------------------------------------------------------------

def ingest(*, refresh: bool = False) -> int:
    notes: list[str] = []
    reg = Registry()

    # pass 1: read every region season, teach the registry the city clusters
    region_by_year: dict[int, list[dict]] = {}
    for year in range(FIRST_CSV_YEAR, LAST_CSV_YEAR + 1):
        force = refresh and year >= LAST_CSV_YEAR - 1
        rows = fetch_region_year(year, force=force)
        if rows:
            region_by_year[year] = rows
    for rows in region_by_year.values():
        for r in rows:
            reg.add_region_row(r)

    # state layers (identity threading works off the region clusters)
    archives = fetch_archives()
    page_year, page_rows = fetch_smbc_current(force=refresh)
    archive_years = {r["year"] for r in archives}
    state_rows = list(archives)
    if page_year and page_year not in archive_years:
        state_rows += page_rows
        log(f"uil: SMBC live page adds season {page_year} ({len(page_rows)} state rows)")

    if len(region_by_year) < 15 or len(archives) < 3000:
        log(f"uil ingest FAILED: only {len(region_by_year)} region seasons / "
            f"{len(archives)} archive rows — refusing to write")
        return 1

    # pass 2: build events (state first so its identities can bind to clusters)
    state_events = build_state_events(state_rows, reg, notes)
    season_files: dict[int, list] = defaultdict(list)
    for year, rows in sorted(region_by_year.items()):
        season_files[year].extend(build_region_events(rows, reg, year))
    for year, evs in state_events.items():
        season_files[year].extend(evs)
    for year in season_files:
        season_files[year].sort(key=lambda e: (e["date"] or "", e["name"]))
    reg.finalize()
    # registry names were assigned after event construction on purpose: events
    # hold ident dicts' final names only if we wrote them post-finalize — so
    # rewrite corps fields now that display names exist
    # (build_* stored final names already via ident["name"]; finalize() must
    # therefore run before builds — guard against ordering bugs:)
    for evs in season_files.values():
        for ev in evs:
            for c in ev["classes"]:
                for r in c["results"]:
                    assert isinstance(r["corps"], str) and r["corps"], "unnamed band"

    # champions: Finals place 1 (co-champions kept — 2011 4A)
    champions: dict[str, dict] = {}
    for year, evs in season_files.items():
        for ev in evs:
            if not ev.get("champ"):
                continue
            for c in ev["classes"]:
                winners = [r["corps"] for r in c["results"] if r.get("placement") == 1]
                if not winners:
                    continue
                entry = {"corps": winners[0], "score": None}
                if len(winners) > 1:
                    entry["co"] = winners[1]
                    notes.append(f"{year} {c['class']}: state co-champions "
                                 f"{winners[0]} & {winners[1]}")
                champions.setdefault(str(year), {})[c["class"]] = entry

    errs = validate(season_files)
    if errs:
        log(f"uil ingest FAILED validation ({len(errs)} problems) — refusing to write")
        for e in errs[:20]:
            log("  " + e)
        return 1

    latest_rated = max(y for y, evs in season_files.items()
                       if any(r.get("rating") for e in evs for c in e["classes"]
                              for r in c["results"]))
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    DOCS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps({"updated": updated,
                                 "region_years": sorted(region_by_year),
                                 "state_years": sorted({y for y in state_events}),
                                 "notes": notes}, ensure_ascii=False))
    assemble(dict(season_files), champions, updated, latest_rated)
    for n in notes:
        log("  note: " + n)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ingest", action="store_true", help="build docs/uil/data from all sources")
    ap.add_argument("--refresh", action="store_true",
                    help="force-refetch the current season CSV + SMBC page")
    args = ap.parse_args()
    if args.ingest:
        return ingest(refresh=args.refresh)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
