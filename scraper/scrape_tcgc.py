#!/usr/bin/env python3
"""TCGC (Texas Color Guard Circuit) live ingest via CompetitionSuite's public
bridge API — the platform TCGC's own texascolorguardcircuit.org/scores-and-recap
page links for every published result.

Mechanism (verified live, see data/circuit-probes/winterguard-west.md):
TCGC has no publicly discoverable CompetitionSuite *organization* GUID, but one
recap GUID per season unlocks that whole season: GetCompetition returns its
seasonGuid, and GetCompetitionsBySeason returns the complete competition list.
The per-season GUIDs below were harvested from the circuit's own scores pages
(Wayback copies of texascolorguardcircuit.org/scores and a fresh snapshot of
/scores-and-recap) and are committed as config — they are stable identifiers.

Two modes:

  --discover           re-verify every committed season GUID against the bridge
                       and write data/tcgc_probe.json; never touches docs/.
  --ingest --year Y    pull one season: every competition -> rounds (name/
                       score/rank as pure JSON) plus the competition's public
                       recap page for judge-level caption scores, then rebuild
                       the full app dataset in docs/tcgc/data/ across every
                       season kept in live_store.json — but ONLY if validation
                       passes. On success a LIVE marker stops the demo
                       generator from overwriting real results.
  --ingest-all         every committed season, oldest first, then one rebuild.

Honesty & care: everything goes through the shared rate-limited fetch() cache
(historical seasons are cache-first — reruns are free); the bridge API and
recap pages are the public score surface TCGC itself links to. A failed or
partial scrape never erases previously published data; rounds whose scores are
implausible and caption rows whose arithmetic doesn't reconcile are dropped
and logged. 2021 is intentionally absent: TCGC's COVID season published
placements only (no scores) — see the probe report.
"""
from __future__ import annotations

import argparse
import hashlib
import html as htmllib
import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from common import ROOT, fetch, log, norm_space, slugify
import scrape_compsuite as cs

DOCS = ROOT / "docs" / "tcgc" / "data"
STORE = DOCS / "live_store.json"
PROBE_OUT = ROOT / "data" / "tcgc_probe.json"
RECAPS = "https://recaps.competitionsuite.com"

# Season GUIDs, harvested from texascolorguardcircuit.org's own scores pages
# (Wayback snapshots 20240301050724 + 20251014235719 of /scores; fresh snapshot
# 20260808002828 of /scores-and-recap for 2026) and resolved live through
# GetCompetition -> seasonGuid -> GetCompetitionsBySeason (org initials TCGC on
# every response). 2021 published placements only (COVID) — no scores exist.
SEASONS = {
    2013: "d1ec22ed-ac41-40ea-9db9-fc499fe4bd10",
    2014: "25bca0d4-cbc7-474a-a699-d7a2b62c304a",
    2015: "2716ec64-fa93-4ccc-891e-863b76ec7460",
    2016: "23f7de9c-3fbe-44c8-be91-a4a5bf0b354d",
    2017: "aec82451-105a-427f-9016-aaf24c1da7bf",
    2018: "d73f0951-c051-498c-ad1f-a123dd38162f",
    2019: "f1628b29-f585-4e16-8e1c-345d0e720144",
    2020: "beae23b7-9e65-4e9e-93ad-244d37190957",
    2022: "637b2455-7a45-4191-afde-ab59e658b971",
    2023: "c34e8f2c-9745-430b-a1d6-303e088b4832",
    2024: "6d4ae385-fa53-4476-b0c8-88a3cf9a69e5",
    2025: "ba3ab474-66a7-4939-9d3f-ff2e2f52ffe9",
    2026: "31377389-96c0-4b5b-b26c-d2d7585556ae",
}

SCORE_MIN, SCORE_MAX = 10.0, 100.0


def bridge(endpoint: str, *, force: bool = False):
    """Bridge JSON with the same JSONP-wrapper stripping as scrape_compsuite,
    but cache-first by default — finished seasons never change, so reruns are
    free. force=True re-fetches (for the season currently in progress)."""
    txt = fetch(f"{cs.BRIDGE}/{endpoint}", force=force, accept_json=True)
    if txt is None and force:
        txt = fetch(f"{cs.BRIDGE}/{endpoint}", accept_json=True)
    if not txt:
        return None
    txt = txt.strip()
    if not txt.startswith("{") and not txt.startswith("["):
        i, j = txt.find("("), txt.rfind(")")
        if 0 <= i < j:
            txt = txt[i + 1:j]
    try:
        return json.loads(txt)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# names & classes
# ---------------------------------------------------------------------------

# flight/panel split a class runs in at one show ("Scholastic Regional A
# (Red Round)", "Novice (Blue)") — same class, union the rows and re-rank
FLIGHT_RE = re.compile(r"\s*[-–(]\s*(?:Red|Blue|White|Green|Gold|Silver|Purple|Orange)"
                       r"(?:\s+Round)?\)?\s*$", re.I)
# rounds that aren't competitive classes
NONCLASS_RE = re.compile(r"exhibition|critique|clinic|solo|ensemble\b.*only|festival rating", re.I)
# events that carry no circuit scores at all
NONEVENT_RE = re.compile(r"solo\s*&?\s*ensemble|critique|clinic|field day|training", re.I)


def norm_class(name: str) -> str:
    c = norm_space(htmllib.unescape(name or ""))
    c = FLIGHT_RE.sub("", c)
    return norm_space(c)


def display_name(unit: str) -> str:
    n = norm_space(htmllib.unescape(unit or ""))
    # guest performers carry a real judged score — keep the row, thread the
    # ensemble's identity by stripping the tag
    n = re.sub(r"\s*\((?:guest|exhibition)\)\s*$", "", n, flags=re.I)
    n = re.sub(r"\bH\.?\s?S\.?(?=$|\s)", "HS", n)
    n = re.sub(r"\bHigh School\b", "HS", n)
    n = re.sub(r"\bMiddle School\b", "MS", n)
    return norm_space(n).rstrip("*+^~, ")


# display order: guard classes best-first, then percussion, then winds.
_ACT_ORDER = ["", "Percussion ", "Winds "]
_TIER_ORDER = ["World", "Open", "National A", "A", "AA", "JV A",
               "Regional A", "JV Regional A", "Cadet Regional A",
               "Cadet Novice", "Novice", "Cadet"]
_SI_ORDER = ["Scholastic", "Independent", ""]


def class_sort_key(cls: str) -> tuple:
    c = cls
    act = 0
    if c.startswith("Percussion "):
        act, c = 1, c[len("Percussion "):]
    elif c.startswith("Winds "):
        act, c = 2, c[len("Winds "):]
    concert = 0
    if c.startswith("Scholastic Concert "):
        concert, c = 1, "Scholastic " + c[len("Scholastic Concert "):]
    si = 2
    for i, p in enumerate(("Scholastic", "Independent")):
        if c.startswith(p):
            si, c = i, norm_space(c[len(p):])
            break
    tier = _TIER_ORDER.index(c) if c in _TIER_ORDER else len(_TIER_ORDER)
    return (act, concert, tier, si, cls)


def event_name(comp: dict) -> str:
    n = norm_space(comp.get("name") or "")
    half = n.split(" - ")
    if len(half) == 2 and half[0] == half[1]:  # 2013-era "X - X" duplication
        n = half[0]
    return n


def is_champ_event(name: str) -> bool:
    """The circuit-level season finals champions.json is built from. Area /
    East / West / regional-class championship sites run in parallel (several
    winners per class), so only state/circuit-level finals count."""
    n = name.lower()
    if "prelim" in n or "solo" in n:
        return False
    if "state championship" in n or "circuit championship" in n:
        return True
    return bool(re.search(r"\bchampionship", n)) and not any(
        q in n for q in ("area", "east", "west", "north", "south",
                         "cadet", "novice", "sra", "sjvra", "regional"))


# ---------------------------------------------------------------------------
# caption recaps (judge-level sheets from the public recap page)
# ---------------------------------------------------------------------------

# Superset of every TCGC sheet family (verified live against real recaps):
#   guard:        eq / mv / dsg / ge (ge1+ge2 judge totals where doubled)
#   guard 2013:   ge / pa / vis   (General Effect, Performance Analysis, Visual)
#   percussion:   em / ev / mus / vis; concert percussion: em / mus
#   perc 2013:    perf / art      (Performance, Artistry)
#   winds:        oe / ma / va
# A class only ever fills its own sheet's columns; the rest stay null.
CAPTION_COLS = ["eq", "mv", "dsg", "ge1", "ge2", "ge", "pa", "em", "ev", "oe",
                "ma", "mus", "va", "vis", "perf", "art", "pen", "tot"]
# normalized caption-group heading -> column ("Ensemble Analysis" was the
# design caption's name on early-2010s guard sheets)
COLMAP = {
    "e": "eq", "equipment": "eq", "equipment analysis": "eq",
    "m": "mv", "movement": "mv", "movement analysis": "mv",
    "da": "dsg", "design": "dsg", "design analysis": "dsg", "ensemble analysis": "dsg",
    "ge": "ge", "general effect": "ge",
    "pa": "pa", "performance analysis": "pa",
    "effect - music": "em", "effect-music": "em", "effect": "em",
    "effect - visual": "ev", "effect-visual": "ev",
    "overall effect": "oe",
    "music analysis": "ma", "music": "mus",
    "visual analysis": "va", "visual": "vis",
    "performance": "perf", "artistry": "art",
}
UNMAPPED_GROUPS: set[str] = set()   # reported by ingest so sheet drift is visible

_SECT = re.compile(r"<a name='(?:round|division)_([0-9a-f-]{36})'")
_TR = re.compile(r"<tr\b.*?</tr>", re.S)
_CELL = re.compile(r"<td\b([^>]*)>(.*?)</td>", re.S)
# unit row: name cell, then an optional location cell (blank on many rows,
# absent entirely on 2013-era sheets), both 'content topBorder
# rightBorderDouble' — TCGC recaps put a style attribute on these cells, which
# is why scrape_compsuite's stricter _ANCHOR is not reused
_ANCH = re.compile(r"<td class='content topBorder rightBorderDouble'[^>]*>\s*(?:<a[^>]*>)?"
                   r"([^<]+?)\s*(?:</a>)?\s*</td>"
                   r"(?:\s*<td class='content topBorder rightBorderDouble'[^>]*>[^<]*</td>)?")


def _cells(row: str) -> list[tuple[str, int, int, bool]]:
    """(text, colspan, rowspan, is_caption_group) per <td>."""
    out = []
    for m in _CELL.finditer(row):
        attrs, inner = m.group(1), m.group(2)
        csn = re.search(r"colspan='?\"?(\d+)", attrs)
        rsn = re.search(r"rowspan='?\"?(\d+)", attrs)
        txt = re.sub(r"<[^>]+>", " ", inner)
        txt = norm_space(htmllib.unescape(txt).replace("\xa0", " "))
        out.append((txt, int(csn.group(1)) if csn else 1,
                    int(rsn.group(1)) if rsn else 1, "captionTotal" in attrs))
    return out


def _leaf_layout(sec: str) -> list[tuple[str, str]] | None:
    """[(group, leaf-label)] per data-row score cell, from the sheet's header
    rows: the groups row names the caption blocks in captionTotal-classed cells
    (colspan = leaf count); rowspan cells like Sub Total / Total are their own
    single columns. Cells before the first caption group are the unit-name /
    location / flight-label placeholders and contribute no score cells."""
    a0 = _ANCH.search(sec)
    trs = _TR.findall(sec[:a0.start()]) if a0 else []
    if len(trs) < 3:
        return None
    grow, crow = _cells(trs[-3]), _cells(trs[-1])
    leaf_q = [t for t, csn, _, _ in crow for _ in range(csn)]
    layout: list[tuple[str, str]] = []
    started = False
    for txt, csn, rsn, grp in grow:
        if not started and not grp:
            continue
        started = True
        if grp:
            for _ in range(csn):
                if not leaf_q:
                    return None
                layout.append((txt, leaf_q.pop(0)))
        else:
            layout.append((txt, txt))       # Sub Total / Total columns
    return layout if layout and not leaf_q else None


_SCORE_TXT = re.compile(r"class='content score'[^>]*>\s*([^<]*?)\s*<")


def _num(raw: str) -> float | None:
    raw = (raw or "").strip()
    if raw in ("", "-", "--"):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def parse_recap_captions(html_page: str) -> dict[str, list[dict]]:
    """Competition recap page -> {round_guid: [{corps, <caption cols>, pen,
    tot}]}. Sheet-agnostic: caption groups are read from the section's own
    header and mapped through COLMAP, so guard, percussion and winds sheets of
    every era all parse. Every row must reconcile arithmetically against the
    sheet's own Sub Total / Total columns (some sheets scale the caption sum
    ×1.25) or it is dropped — a mis-parse can never surface as a wrong score."""
    out: dict[str, list[dict]] = {}
    secs = [(m.start(), m.group(1)) for m in _SECT.finditer(html_page)]
    for k, (pos, guid) in enumerate(secs):
        end = secs[k + 1][0] if k + 1 < len(secs) else len(html_page)
        sec = html_page[pos:end]
        layout = _leaf_layout(sec)
        if not layout:
            continue
        # caption-group runs (consecutive leaves sharing a heading) + specials
        runs: list[tuple[str, list[int]]] = []
        pen_leaves: list[tuple[str, int]] = []
        i_sub = i_tot = None
        for i, (g, leaf) in enumerate(layout):
            gl = norm_space(g.lower().strip("*"))
            if "penal" in gl or "timing" in gl:
                pen_leaves.append((leaf.lower().strip("* ."), i))
            elif gl.startswith("sub"):
                i_sub = i
            elif gl.startswith("total"):
                i_tot = i
            elif gl:
                if not runs or runs[-1][0] != gl:
                    runs.append((gl, []))
                runs[-1][1].append(i)
        if i_tot is None or len(runs) < 2:
            continue
        i_pen = None
        if pen_leaves:   # prefer the group's Tot column, else its Pen column
            tots = [i for ll, i in pen_leaves if ll == "tot"]
            i_pen = tots[-1] if tots else pen_leaves[-1][1]
        # per group: judge sub-totals + the combined caption total (last Tot)
        caption_idx: list[tuple[str | None, int, list[int]]] = []
        ok_sheet = True
        for gl, leaf_idx in runs:
            tots = [i for i in leaf_idx
                    if layout[i][1].lower().strip("* .") in ("tot", "total")]
            if not tots:
                ok_sheet = False
                break
            col = COLMAP.get(gl)
            if col is None:
                UNMAPPED_GROUPS.add(gl)
            caption_idx.append((col, tots[-1], tots[:-1]))
        if not ok_sheet:
            continue
        anchors = list(_ANCH.finditer(sec))
        rows = []
        for j, a in enumerate(anchors):
            aend = anchors[j + 1].start() if j + 1 < len(anchors) else len(sec)
            vals = []
            for cell in cs._SCORE_CELL.finditer(sec[a.end():aend]):
                nm = cs._NUM.search(cell.group(2))
                if not nm:  # 2013-era sheets carry the value as plain cell text
                    nm = _SCORE_TXT.search(cell.group(2))
                vals.append(_num(nm.group(1)) if nm else None)
            if len(vals) != len(layout):
                continue
            take: dict[str, float | None] = {c: None for c in CAPTION_COLS}
            base = 0.0
            complete = True
            for col, i_val, judge_tots in caption_idx:
                v = vals[i_val]
                if v is None:
                    complete = False
                    break
                base += v
                if col:
                    take[col] = v
                if col == "ge" and len(judge_tots) >= 2:
                    take["ge1"], take["ge2"] = vals[judge_tots[0]], vals[judge_tots[1]]
            tot = vals[i_tot]
            if not complete or tot is None:
                continue
            # 2013 sheets print penalties negative — store magnitude
            pen = abs(vals[i_pen] or 0.0) if i_pen is not None else 0.0
            sub = vals[i_sub] if i_sub is not None else None
            take["pen"], take["tot"] = pen, tot
            if sub is not None:
                ok = (any(abs(f * base - sub) <= 0.06 for f in (1.0, 1.25))
                      and abs(sub - pen - tot) <= 0.051)
            else:
                ok = any(abs(f * base - pen - tot) <= 0.06 for f in (1.0, 1.25))
            if not ok or tot < SCORE_MIN:
                continue
            rows.append({"corps": display_name(a.group(1)), **take})
        if rows:
            out[guid] = rows
    return out


# ---------------------------------------------------------------------------
# season ingest
# ---------------------------------------------------------------------------

def parse_competition(comp: dict, year: int, *, force: bool = False,
                      stats: dict | None = None) -> dict | None:
    """One bridge competition -> {name, date, venue, url, champ, classes,
    captions} or None. Flights (Red/Blue/White) of one class are unioned and
    re-ranked by score; a unit's best outing of the event is kept."""
    name = event_name(comp)
    date = (comp.get("competitionDate") or "")[:10]
    if NONEVENT_RE.search(name):
        return None
    if not re.match(r"\d{4}-\d{2}-\d{2}$", date) or int(date[:4]) != year:
        if stats is not None:
            stats.setdefault("skipped_date", []).append(f"{name} ({date})")
        return None
    guid = comp.get("competitionGuid")
    detail = bridge(f"GetCompetition/jsonp?competition={guid}", force=force)
    if not detail:
        if stats is not None:
            stats.setdefault("skipped_nodetail", []).append(name)
        return None

    classes: dict[str, dict[str, dict]] = {}   # cls -> corps -> row
    round_cls: dict[str, str] = {}             # round guid -> cls
    for rnd in detail.get("rounds") or []:
        rname = norm_space(rnd.get("name") or "")
        if not rname or NONCLASS_RE.search(rname):
            continue
        cls = norm_class(rname)
        if not cls:
            continue
        for key in ("roundGuid", "divisionGuid"):
            rguid = (rnd.get(key) or "").lower()
            if rguid:
                round_cls[rguid] = cls
        for p in rnd.get("performances") or []:
            unit = display_name(p.get("name") or "")
            score = p.get("score")
            if not unit or score is None:
                continue
            score = round(float(score), 3)
            if not (SCORE_MIN <= score <= SCORE_MAX):
                if stats is not None and score > 0:
                    stats.setdefault("dropped_scores", []).append(f"{name}/{cls}: {unit} {score}")
                continue
            cur = classes.setdefault(cls, {})
            if unit not in cur or score > cur[unit]["score"]:
                cur[unit] = {"corps": unit, "score": score}
    classes_out = []
    for cls in sorted(classes, key=class_sort_key):
        ranked = sorted(classes[cls].values(), key=lambda r: -r["score"])
        if not ranked:
            continue
        classes_out.append({"class": cls,
                            "results": [{"place": i + 1, **r} for i, r in enumerate(ranked)]})
    if not classes_out:
        return None

    captions: list[dict] = []
    recap_html = fetch(f"{RECAPS}/{guid}.htm", force=force)
    if recap_html:
        best: dict[tuple[str, str], dict] = {}   # one row per class+unit
        for rguid, rows in parse_recap_captions(recap_html).items():
            cls = round_cls.get(rguid)
            if not cls:
                continue
            for r in rows:
                key = (cls, r["corps"])
                if key not in best or r["tot"] > best[key]["tot"]:
                    best[key] = {"cls": cls, **r}
        captions = list(best.values())

    return {"name": name, "date": date,
            "venue": norm_space(comp.get("location") or "") or None,
            "url": f"{RECAPS}/{guid}.htm", "champ": is_champ_event(name),
            "classes": classes_out, "captions": captions}


def ingest_season(year: int, *, force: bool = False) -> list[dict] | None:
    guid = SEASONS.get(year)
    if not guid:
        log(f"tcgc {year}: no committed season GUID")
        return None
    d = bridge(f"GetCompetitionsBySeason/jsonp?season={guid}", force=force) or {}
    comps = d.get("competitions") or []
    if (d.get("organizationInitials") or "").upper() not in ("TCGC", ""):
        log(f"tcgc {year}: season {guid} is not TCGC ({d.get('organizationInitials')}) — skipping")
        return None
    log(f"tcgc {year}: {len(comps)} competitions listed ({d.get('name')})")
    stats: dict = {}
    events = []
    for comp in comps:
        ev = parse_competition(comp, year, force=force, stats=stats)
        if ev:
            events.append(ev)
            log(f"  {ev['date']} {ev['name']} — {len(ev['classes'])} classes, "
                f"{sum(len(c['results']) for c in ev['classes'])} rows, "
                f"{len(ev['captions'])} caption rows")
    for k, v in stats.items():
        log(f"tcgc {year}: {k}: {len(v)} — {v[:4]}")
    if UNMAPPED_GROUPS:
        log(f"tcgc {year}: caption groups without a column (values verified but "
            f"not exported): {sorted(UNMAPPED_GROUPS)}")
        UNMAPPED_GROUPS.clear()
    n_rows = sum(len(c["results"]) for e in events for c in e["classes"])
    if len(events) < 5 or n_rows < 100:
        log(f"tcgc {year}: validation FAILED ({len(events)} events, {n_rows} rows) — season not stored")
        return None
    log(f"tcgc {year}: OK — {len(events)} events, {n_rows} result rows, "
        f"{sum(len(e['captions']) for e in events)} caption rows")
    return sorted(events, key=lambda e: e["date"])


# ---------------------------------------------------------------------------
# dataset assembly — the exact contract docs/usbands/data/ publishes
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    base = re.sub(r"\s*\([A-Z]{2}\)$", "", name)
    h = int(hashlib.md5(f"{base}|hue".encode()).hexdigest()[:8], 16) % 360
    c1, c2 = f"hsl({h},55%,30%)", f"hsl({(h + 42) % 360},75%,52%)"
    words = [w for w in re.findall(r"[A-Za-z0-9]+", base)
             if w.upper() not in ("HS", "MS", "JV", "THE", "OF")]
    ini = "".join(w[0] for w in words[:2]).upper() or base[:2].upper()
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
           f"<stop offset='0' stop-color='{c1}'/><stop offset='1' stop-color='{c2}'/>"
           "</linearGradient></defs>"
           "<rect width='64' height='64' rx='14' fill='url(#g)'/>"
           f"<text x='32' y='42' font-family='system-ui,sans-serif' font-size='27' "
           f"font-weight='800' fill='#fff' text-anchor='middle'>{ini}</text></svg>")
    return "data:image/svg+xml;utf8," + quote(svg, safe="") + "#logo.svg"


def assemble(store: dict, updated: str) -> None:
    years = sorted(int(y) for y in store["years"])
    (DOCS / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS / "corps").mkdir(exist_ok=True)
    (DOCS / "db").mkdir(exist_ok=True)
    (DOCS / "captions").mkdir(exist_ok=True)

    perfs: dict[tuple[str, str], list[dict]] = {}
    season_files: dict[int, list] = {}
    champions: dict[str, dict] = {}
    caption_files: dict[int, list] = {}
    db_rows = []
    for year in years:
        season_events = []
        champ_latest: dict[str, tuple[str, dict]] = {}   # cls -> (date, top row)
        cap_rows = []
        for ev in sorted(store["years"][str(year)], key=lambda e: e["date"]):
            for c in ev["classes"]:
                for r in c["results"]:
                    perfs.setdefault((c["class"], r["corps"]), []).append(
                        {"y": year, "d": ev["date"], "ev": ev["name"], "cls": c["class"],
                         "p": r["place"], "s": r["score"], "champ": bool(ev.get("champ"))})
                    db_rows.append([year, ev["date"], ev["name"], r["corps"],
                                    c["class"], r["place"], r["score"]])
                if ev.get("champ") and c["results"]:
                    prev = champ_latest.get(c["class"])
                    if not prev or ev["date"] >= prev[0]:
                        champ_latest[c["class"]] = (ev["date"], c["results"][0])
            for cap in ev.get("captions") or []:
                cap_rows.append([ev["date"], ev["name"], cap["cls"], cap["corps"]]
                                + [cap.get(c) for c in CAPTION_COLS])
            season_events.append({
                "name": ev["name"], "date": ev["date"],
                "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
                "location": ev.get("venue"), "url": ev.get("url"), "source": "competitionsuite",
                "classes": ev["classes"], "has_recap": False,
            })
        season_files[year] = season_events
        if cap_rows:
            caption_files[year] = cap_rows
        for cls, (_d, top) in champ_latest.items():
            champions.setdefault(str(year), {})[cls] = {"corps": top["corps"], "score": top["score"]}

    latest = years[-1]
    classes = sorted({cls for cls, _ in perfs}, key=class_sort_key)
    standings = {}
    for cls in classes:
        rows = []
        for (c, name), hist in perfs.items():
            if c != cls:
                continue
            season_hist = sorted((p for p in hist if p["y"] == latest), key=lambda p: p["d"])
            if not season_hist:
                continue
            last, prev = season_hist[-1], (season_hist[-2] if len(season_hist) > 1 else None)
            best = max(season_hist, key=lambda p: p["s"])
            rows.append({
                "corps": name, "score": last["s"], "date": last["d"], "event": last["ev"],
                "high": best["s"], "high_event": best["ev"], "high_date": best["d"],
                "prev_score": prev["s"] if prev else None,
                "delta": round(last["s"] - prev["s"], 3) if prev else None,
                "outings": len(season_hist),
                "trend": [[p["d"], p["s"]] for p in season_hist],
            })
        if not rows:
            continue
        rows.sort(key=lambda r: -r["score"])
        for i, r in enumerate(rows):
            r["rank"] = i + 1
        movers = sorted((r for r in rows if isinstance(r.get("delta"), (int, float))),
                        key=lambda r: -r["delta"])[:3]
        battles = sorted(
            ({"a": rows[i - 1]["corps"], "b": r["corps"], "ra": rows[i - 1]["rank"], "rb": r["rank"],
              "sa": rows[i - 1]["score"], "sb": r["score"],
              "gap": round(abs(rows[i - 1]["score"] - r["score"]), 3)}
             for i, r in enumerate(rows) if i > 0),
            key=lambda b: (b["gap"], b["ra"]))[:3]
        standings[cls] = {"rows": rows, "movers": movers, "battles": battles}

    recent = []
    for ev in reversed(season_files[latest][-3:]):
        top_cls = ev["classes"][0]
        top = top_cls["results"][0]
        recent.append({"name": ev["name"], "date": ev["date"], "location": ev["location"],
                       "winner": {"corps": top["corps"], "score": top["score"],
                                  "class": top_cls["class"]}})

    idx, profiles = [], {}
    by_name: dict[str, list] = {}
    for (cls, name), plist in perfs.items():
        by_name.setdefault(name, []).extend(plist)
    for name, plist in by_name.items():
        sl = slugify(name)
        plist.sort(key=lambda p: (p["y"], p["d"] or ""))
        yrs = sorted({p["y"] for p in plist})
        series = []
        for y in yrs:
            ys = [p for p in plist if p["y"] == y]
            best_p = max(ys, key=lambda p: p["s"])
            series.append([y, best_p["s"], best_p["cls"]])
        best = max(p["s"] for p in plist)
        idx.append({"name": name, "slug": sl, "first": yrs[0], "last": yrs[-1],
                    "seasons": len(yrs), "best": best, "n": len(plist), "series": series})
        (DOCS / "corps" / f"{sl}.json").write_text(
            json.dumps({"name": name, "performances": plist}))
        cls_now = plist[-1]["cls"]
        titles = sorted(y for y, cl in champions.items()
                        if any(v.get("corps") == name for v in cl.values()))
        profiles[sl] = {
            "title": name,
            "img": monogram(name),
            "summary": f"{name} competes in TCGC {cls_now}. "
            + (f"TCGC state champion: {', '.join(titles)}. " if titles else "")
            + f"Scores from official TCGC recaps, {yrs[0]}–{yrs[-1]}.",
        }
    idx.sort(key=lambda c: c["name"])

    records = {}
    for cls in classes:
        flat = [(n, p) for (c, n), pl in perfs.items() if c == cls for p in pl]
        top = sorted(flat, key=lambda t: -t[1]["s"])[:10]
        finals = {}
        for y in years:
            rows = sorted(((n, p["s"]) for n, p in flat if p["y"] == y and p["champ"]),
                          key=lambda r: -r[1])
            if rows:
                finals[str(y)] = [[n, s] for n, s in rows]
        records[cls] = {"top": [[p["y"], p["d"], n, p["s"], p["ev"]] for n, p in top],
                        "finals": finals}

    by_decade: dict[str, list] = {}
    for row in db_rows:
        by_decade.setdefault(f"{row[0] // 10 * 10}s", []).append(row)

    # demo files a live rebuild does not cover must not survive it
    for p in (DOCS / "seasons").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in years:
            p.unlink()
    live_slugs = {c["slug"] for c in idx}
    for p in (DOCS / "corps").glob("*.json"):
        if p.stem not in live_slugs:
            p.unlink()
    for p in (DOCS / "captions").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in caption_files:
            p.unlink()

    w = lambda rel, obj: (DOCS / rel).write_text(json.dumps(obj))
    w("meta.json", {"updated": updated,
                    "seasons": [{"year": y, "events": len(season_files[y])} for y in years]})
    w("rankings.json", {"generated": updated, "season": latest, "standings": standings,
                        "recent_events": recent})
    for y in years:
        w(f"seasons/{y}.json", season_files[y])
    w("upcoming.json", [])
    w("corps_index.json", idx)
    w("profiles.json", profiles)
    w("champions.json", champions)
    w("records.json", records)
    w("db/index.json", [{"decade": d, "rows": len(rows)} for d, rows in sorted(by_decade.items())])
    for d, rows in by_decade.items():
        w(f"db/perfs_{d}.json", sorted(rows, key=lambda r: (r[0], r[1] or "")))
    w("captions/index.json", {
        "seasons": [{"year": y, "rows": len(caption_files[y])} for y in sorted(caption_files)],
        "cols": ["date", "event", "class", "corps"] + CAPTION_COLS})
    for y, rows in caption_files.items():
        w(f"captions/{y}.json", sorted(rows, key=lambda r: (r[0], r[1], r[2])))
    (DOCS / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"tcgc: wrote {sum(len(v) for v in season_files.values())} events across {years}, "
        f"{sum(len(v['rows']) for v in standings.values())} standings rows, {len(idx)} ensembles, "
        f"{sum(len(v) for v in caption_files.values())} caption rows in {len(caption_files)} seasons")


def load_store() -> dict:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text())
        except Exception:  # noqa: BLE001
            pass
    return {"years": {}}


def ingest(year: int, *, force: bool = False) -> int:
    events = ingest_season(year, force=force)
    if events is None:
        return 1
    store = load_store()
    store.setdefault("years", {})[str(year)] = events
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    return 0


def ingest_all(*, force_latest: bool = False) -> int:
    store = load_store()
    DOCS.mkdir(parents=True, exist_ok=True)
    ok = 0
    for year in sorted(SEASONS):
        events = ingest_season(year, force=force_latest and year == max(SEASONS))
        if events is not None:
            store.setdefault("years", {})[str(year)] = events
            STORE.write_text(json.dumps(store))   # survive an interrupted run
            ok += 1
    if not ok:
        return 1
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    return 0


def discover() -> int:
    report = {"source": "tcgc", "probed_at": datetime.now(timezone.utc).isoformat(),
              "seasons": {}}
    ok = 0
    for year, guid in sorted(SEASONS.items()):
        d = bridge(f"GetCompetitionsBySeason/jsonp?season={guid}") or {}
        comps = d.get("competitions") or []
        report["seasons"][year] = {"guid": guid, "name": d.get("name"),
                                   "org": d.get("organizationInitials"),
                                   "competitions": len(comps)}
        if comps and d.get("organizationInitials") == "TCGC":
            ok += 1
        log(f"tcgc discover {year}: {d.get('organizationInitials')} '{d.get('name')}' "
            f"{len(comps)} comps")
    PROBE_OUT.parent.mkdir(parents=True, exist_ok=True)
    PROBE_OUT.write_text(json.dumps(report, indent=1, default=str))
    log(f"tcgc discover: {ok}/{len(SEASONS)} seasons verified -> {PROBE_OUT}")
    return 0 if ok == len(SEASONS) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--discover", action="store_true",
                    help="verify committed season GUIDs, write data/tcgc_probe.json")
    ap.add_argument("--ingest", action="store_true",
                    help="pull --year's season and rebuild docs/tcgc/data (validated)")
    ap.add_argument("--ingest-all", action="store_true",
                    help="pull every committed season, then one rebuild")
    ap.add_argument("--year", type=int, default=max(SEASONS))
    ap.add_argument("--fresh", action="store_true",
                    help="re-fetch the target (latest) season instead of using the cache")
    args = ap.parse_args()
    if args.discover:
        return discover()
    if args.ingest_all:
        return ingest_all(force_latest=args.fresh)
    if args.ingest:
        return ingest(args.year, force=args.fresh)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
