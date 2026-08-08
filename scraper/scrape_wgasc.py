#!/usr/bin/env python3
"""WGASC (Winter Guard Association of Southern California) live ingest via
CompetitionSuite's public bridge API — the largest regional winter circuit
(~300+ color guards, plus the circuit's percussion & winds divisions).

Mechanism (probed live, see data/circuit-probes/winterguard-west.md):
WGASC exposes no public organization GUID, but season GUIDs unlock everything:
GetCompetitionsBySeason(season) -> the season's full competition list ->
GetCompetition(competition) -> rounds with {name, performances[name/score/rank],
fullRecapUrl}. Scores and ranks come straight from the bridge JSON; each
round's recap .htm page carries the judge-by-judge caption sheet (Equipment
Analysis / Movement / Design Analysis / General Effect on color guard sheets),
which we parse into a DCI-format captions database.

Season GUIDs were seeded from Wayback copies of wgasc.org score pages (the
live site is bot-walled, but every score surface it links — the bridge and
recaps.competitionsuite.com — is public and open). Earlier seasons (pre-2022)
are not on the bridge era of wgasc.org's archived pages; 2021 exists but holds
calendar items only (the COVID year — zero scored competitions).

Usage:
  --ingest --year Y     pull one season into the store + rebuild the dataset
  --ingest --all        pull every known season (2022..2026)
  --assemble            rebuild docs/wgasc/data/ from the existing store only

Honesty & care: every request goes through the shared rate-limited, gzip-
cached fetch(); reruns are free. Validation gates: plausible score bounds,
sequential ranks, no duplicate ensemble rows, caption rows must reconcile
arithmetically AND match the bridge total — otherwise they are dropped and
logged. A failed season never erases previously published data.
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

DOCS = ROOT / "docs" / "wgasc" / "data"
STORE = DOCS / "live_store.json"
BRIDGE = cs.BRIDGE

# Season GUIDs (from the probe + Wayback-seeded recap GUIDs resolved through
# GetCompetition -> seasonGuid; each verified live against the bridge).
SEASONS = {
    2022: "f8b3ccf7-a5ca-4d7d-aced-94bf45722546",   # 47 comps
    2023: "8b091ea8-820d-4e86-b505-081572aa5c07",   # 48 comps
    2024: "2c02537b-691f-442f-950f-4409e152d1b6",   # 46 comps
    2025: "eb34e61d-ec78-4d35-b6e7-ca07df869786",   # 41 comps
    2026: "234b42a3-d573-4994-98a5-2b3bd383f9da",   # 48 comps
}
# 2021: 0511f333-bd69-4540-891f-2b1572d97b06 — calendar items only, 0 scored.

# The circuit's real classes (surveyed across every round name, all seasons).
# Order = display order: guard first (the circuit's headline activity), then
# the percussion and winds divisions the same association runs.
GUARD_CLASSES = [
    "Independent World", "Independent Open", "Independent A Senior",
    "Independent A", "Independent Regional A",
    "Scholastic World", "Scholastic Open", "Scholastic AAA",
    "Scholastic AA", "Scholastic A",
    "High School AA", "High School A",
    "Junior High AAA", "Junior High AA", "Junior High A",
]
PERC_CLASSES = [
    "Percussion Independent World", "Percussion Independent Open",
    "Percussion Independent A",
    "Percussion Scholastic World", "Percussion Scholastic Open",
    "Percussion Scholastic A", "Percussion Scholastic Junior High",
    "Percussion Scholastic Novice", "Percussion Scholastic Regional A",
    "Percussion Scholastic Concert World", "Percussion Scholastic Concert Open",
    "Percussion Scholastic Concert A", "Percussion Scholastic Concert Junior High",
    "Percussion Scholastic Standstill HS", "Percussion Scholastic Standstill JH",
]
WINDS_CLASSES = [
    "Winds Independent World", "Winds Independent Open", "Winds Independent A",
    "Winds Scholastic Open", "Winds Scholastic A",
]
CLASS_ORDER = GUARD_CLASSES + PERC_CLASSES + WINDS_CLASSES
CLASS_RANK = {c: i for i, c in enumerate(CLASS_ORDER)}

SCORE_MIN, SCORE_MAX = 10.0, 100.0


def bridge_json(endpoint: str, *, force: bool = False):
    """Bridge GET honoring the on-disk cache (unlike cs._bridge, which always
    refetches first) — every season here is complete, so reruns are free."""
    txt = fetch(f"{BRIDGE}/{endpoint}", force=force, accept_json=True)
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
# class + name normalization
# ---------------------------------------------------------------------------

ROUND_SUFFIX = re.compile(r"\s*\((?:Round\s*\d+|Finals(?:\s+Round\s*\d+)?)\)\s*$", re.I)
SKIP_ROUNDS = re.compile(r"^(Exhibition|.*Classification)$", re.I)


def norm_class(round_name: str) -> str | None:
    """Round label -> circuit class, or None for non-competitive rounds.
    'WGASC HS AA (Round 2)' -> 'High School AA'; 'Scholastic AA (FINALS)' ->
    'Scholastic AA'; 'Exhibition' / '... Classification' -> None."""
    s = norm_space(htmllib.unescape(round_name or ""))
    s = ROUND_SUFFIX.sub("", s)
    if s.startswith("WGASC "):
        s = s[len("WGASC "):]
    if SKIP_ROUNDS.match(s):
        return None
    s = re.sub(r"^HS\b", "High School", s)
    s = re.sub(r"^JH\b", "Junior High", s)
    return s


def norm_name(name: str) -> str:
    n = norm_space(htmllib.unescape(name or ""))
    n = n.replace("’", "'").replace("‘", "'")
    return n.rstrip("*+^~, ")


CHAMP_RE = re.compile(r"championship", re.I)
NOT_CIRCUIT_CHAMP = re.compile(r"ADLA|SoNev", re.I)


def is_champ(comp_name: str) -> bool:
    """The circuit's own championships weekend. ADLA (a guest league whose
    finals run on WGASC's platform) and the SoNev division championship are
    real events but not circuit titles."""
    return bool(CHAMP_RE.search(comp_name)) and not NOT_CIRCUIT_CHAMP.search(comp_name)


def display_event_name(name: str, location: str | None) -> str:
    """Many WGASC comps are literally named 'Color Guard' — venue makes the
    event identifiable (and keeps two same-day shows distinct)."""
    name = norm_space(name)
    if "@" in name or not location:
        return name
    venue = norm_space(location.split(",")[0])
    if venue and venue.lower() not in name.lower():
        return f"{name} @ {venue}"
    return name


# ---------------------------------------------------------------------------
# recap caption parsing (color-guard sheet: EA / Movement / DA / GE / Pen)
# ---------------------------------------------------------------------------
# The sheet has three header rows — caption groups (class 'captionTotal',
# colspan = leaf cells), judges ('subcaptionTotal'), leaf columns — then one
# <tr> per ensemble whose score cells align 1:1 with the leaf columns, plus
# Sub Total / Total columns (rowspan cells in the header). Regionals use one
# judge per caption (caption total = the judge's Tot cell); championships
# double the panels (2 judges per analysis caption, 4 on GE) and append a
# combined 'captionTotal' cell per group — in both layouts the caption total
# is the LAST cell of the group.

CAPTION_KEYS = {
    "equipment analysis": "ea",
    "movement": "ma",
    "movement analysis": "ma",
    "design analysis": "da",
    "general effect": "ge",
    "timing & penalties": "pen",
    "timing &amp; penalties": "pen",
}
CAPTION_COLS = ["ea", "ma", "da", "ge", "pen"]

_GROUP_CELL = re.compile(
    r"<td (?:colspan='(\d+)' )?class='[^']*\bcaptionTotal\b[^']*'[^>]*>([^<]*)</td>")
_NAME_CELL = re.compile(
    r"<td class='content topBorder rightBorderDouble'[^>]*>([^<]+)</td>\s*"
    r"<td class='content topBorder rightBorderDouble'[^>]*>([^<]*)</td>", re.I)
_SCORE_CELL = re.compile(
    r"<td class='(?:content )?(?:topBorder )?[^']*'[^>]*>\s*"
    r"<table class='scoreTable'.*?data-translate-number='([^']*)'.*?</table>\s*</td>", re.S)
_DIVISION = re.compile(r"header-division-name'><td[^>]*>([^<]+)</td>")


def _num(raw: str) -> float | None:
    raw = (raw or "").strip()
    if raw in ("", "--", "-"):
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return None


def parse_guard_recap(html: str) -> list[dict] | None:
    """One round recap page -> [{corps, ea, ma, da, ge, pen, tot}], or None
    when the sheet is not the color-guard caption layout (percussion & winds
    divisions use different sheets and are skipped by design)."""
    anchors = list(_NAME_CELL.finditer(html))
    if not anchors:
        return None
    # header = everything before the first ensemble row (2022-era recaps have
    # no <!--PerformancesStart--> marker, so split on the first anchor)
    head = html[:anchors[0].start()]

    # caption groups, in sheet order, from the first header row only: cells
    # matched inside the leaf row also carry 'captionTotal' but are span-1
    # unnamed ('Tot' / '&nbsp;') — require a caption name we know.
    groups: list[tuple[str, int]] = []
    for span, label in _GROUP_CELL.findall(head):
        key = CAPTION_KEYS.get(norm_space(htmllib.unescape(label)).lower())
        if key:
            groups.append((key, int(span or 1)))
    if [k for k, _ in groups if k != "pen"] != ["ea", "ma", "da", "ge"]:
        return None  # not a color-guard sheet
    if groups[-1][0] != "pen":
        return None
    # leaf model: caption-group cells ... then Sub Total, then Pen, then Total
    n_caption_cells = sum(s for k, s in groups if k != "pen")
    expected = n_caption_cells + 3  # + Sub Total + Pen + Total
    # index of each caption's total = last cell of its group
    total_idx, pos = {}, 0
    for key, span in groups:
        if key == "pen":
            continue
        pos += span
        total_idx[key] = pos - 1
    pen_idx, tot_idx = n_caption_cells + 1, n_caption_cells + 2

    rows = []
    for k, a in enumerate(anchors):
        corps = norm_name(a.group(1))
        end = anchors[k + 1].start() if k + 1 < len(anchors) else len(html)
        cells = [_num(v) for v in _SCORE_CELL.findall(html[a.end():end])]
        if not corps or len(cells) != expected or any(c is None for c in cells):
            if corps:
                log(f"    caption row dropped ({corps}): {len(cells)}/{expected} cells")
            continue
        row = {"corps": corps, "pen": cells[pen_idx], "tot": cells[tot_idx]}
        for key, idx in total_idx.items():
            row[key] = cells[idx]
        # arithmetic gate: caption totals must rebuild the printed total
        rebuilt = row["ea"] + row["ma"] + row["da"] + row["ge"] - row["pen"]
        if abs(rebuilt - row["tot"]) > 0.015:
            log(f"    caption row dropped ({corps}): {rebuilt:.3f} != {row['tot']}")
            continue
        rows.append(row)
    return rows or None


# ---------------------------------------------------------------------------
# season ingest
# ---------------------------------------------------------------------------

def _merge_round(cls_map: dict, cls: str, perfs: list[dict], eid: str) -> None:
    """Accumulate one round's performances into the event's class map,
    keeping each ensemble's best outing (flights of one class are separate
    rounds; a prelims+finals pair inside one comp keeps the better score)."""
    best = cls_map.setdefault(cls, {})
    prev_rank = 0
    for p in perfs:
        score, rank = p.get("score"), p.get("rank")
        name = norm_name(p.get("name") or "")
        if score is None or not name:
            continue
        score = round(float(score), 3)
        if not (SCORE_MIN <= score <= SCORE_MAX):
            log(f"    {eid} [{cls}] dropped {name} ({score}) — score out of range")
            continue
        if isinstance(rank, int):
            if rank < prev_rank:
                log(f"    {eid} [{cls}] rank order broke at {name} — keeping scores, re-ranking")
            prev_rank = max(prev_rank, rank)
        if name not in best or score > best[name]:
            best[name] = score


def ingest_season(year: int, *, captions: bool = True) -> list[dict] | None:
    sg = SEASONS[year]
    season = bridge_json(f"GetCompetitionsBySeason/jsonp?season={sg}")
    if not season or season.get("organizationInitials") != "WGASC":
        log(f"wgasc {year}: season list unavailable or wrong org — skipping")
        return None
    comps = season.get("competitions") or []
    events: dict[tuple[str, str], dict] = {}
    n_rounds = n_rows = 0
    for comp in sorted(comps, key=lambda c: c.get("competitionDate") or ""):
        guid = comp.get("competitionGuid")
        date = (comp.get("competitionDate") or "")[:10]
        if not guid or not re.match(r"\d{4}-\d{2}-\d{2}$", date) or int(date[:4]) != year:
            continue
        detail = bridge_json(f"GetCompetition/jsonp?competition={guid}")
        if not detail:
            log(f"  {year} {date} {comp.get('name')}: GetCompetition failed — skipped")
            continue
        name = display_event_name(comp.get("name") or "Competition", comp.get("location"))
        key = (date, name)
        ev = events.setdefault(key, {
            "name": name, "date": date, "venue": norm_space(comp.get("location") or "") or None,
            "url": f"https://recaps.competitionsuite.com/{guid}.htm",
            "champ": is_champ(comp.get("name") or ""),
            "cls_map": {}, "cap_map": {},
        })
        for rnd in detail.get("rounds") or []:
            cls = norm_class(rnd.get("name") or "")
            if cls is None:
                continue
            if cls not in CLASS_RANK:
                log(f"  {year} {date} [{rnd.get('name')}] — unknown class, skipped")
                continue
            perfs = rnd.get("performances") or []
            _merge_round(ev["cls_map"], cls, perfs, f"{date} {name}")
            n_rounds += 1
            url = (rnd.get("fullRecapUrl") or "").replace("http://", "https://")
            if captions and url and cls.split()[0] not in ("Percussion", "Winds"):
                html = fetch(url, retries=1)
                cap_rows = parse_guard_recap(html) if html else None
                if cap_rows:
                    ev["cap_map"].setdefault(cls, []).extend(cap_rows)

    out = []
    for (date, name), ev in sorted(events.items()):
        classes = []
        for cls in sorted(ev["cls_map"], key=lambda c: CLASS_RANK[c]):
            ranked = sorted(ev["cls_map"][cls].items(), key=lambda kv: (-kv[1], kv[0]))
            classes.append({"class": cls, "results": [
                {"place": i + 1, "corps": n, "score": s} for i, (n, s) in enumerate(ranked)]})
            n_rows += len(ranked)
        if not classes:
            continue
        # caption cross-check: recap total must equal the bridge score
        captions_out = {}
        for cls, rows in ev["cap_map"].items():
            by_name = {r["corps"]: r["score"]
                       for c in classes if c["class"] == cls for r in c["results"]}
            keep, seen = [], set()
            for r in rows:
                if r["corps"] in seen:
                    continue
                bridge_s = by_name.get(r["corps"])
                if bridge_s is None or abs(bridge_s - r["tot"]) > 0.011:
                    log(f"    {date} {name} [{cls}] caption row dropped "
                        f"({r['corps']}): recap {r['tot']} vs bridge {bridge_s}")
                    continue
                seen.add(r["corps"])
                keep.append([r["corps"], r["ea"], r["ma"], r["da"], r["ge"], r["pen"], r["tot"]])
            if keep:
                captions_out[cls] = keep
        out.append({"name": name, "date": date, "venue": ev["venue"], "url": ev["url"],
                    "champ": ev["champ"], "classes": classes, "captions": captions_out})

    n_caps = sum(len(v) for e in out for v in e["captions"].values())
    log(f"wgasc {year}: {len(out)} events, {n_rounds} rounds, {n_rows} result rows, "
        f"{n_caps} caption rows")
    if len(out) < 15 or n_rows < 500:
        log(f"wgasc {year}: validation FAILED (events/rows below floor) — season not stored")
        return None
    return out


# ---------------------------------------------------------------------------
# dataset assembly — the exact shared-pipeline format (see scrape_usbands.py)
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    base = re.sub(r"\s*\([^)]*\)$", "", name)
    h = int(hashlib.md5(f"{base}|hue".encode()).hexdigest()[:8], 16) % 360
    c1, c2 = f"hsl({h},55%,30%)", f"hsl({(h + 42) % 360},75%,52%)"
    words = [w for w in re.findall(r"[A-Za-z0-9]+", base)
             if w.upper() not in ("HS", "MS", "THE", "OF")]
    ini = "".join(w[0] for w in words[:2]).upper() or base[:2].upper()
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
           f"<stop offset='0' stop-color='{c1}'/><stop offset='1' stop-color='{c2}'/>"
           "</linearGradient></defs>"
           "<rect width='64' height='64' rx='14' fill='url(#g)'/>"
           f"<text x='32' y='42' font-family='system-ui,sans-serif' font-size='27' "
           f"font-weight='800' fill='#fff' text-anchor='middle'>{ini}</text></svg>")
    return "data:image/svg+xml;utf8," + quote(svg, safe="") + "#logo.svg"


def class_sort_key(cls: str):
    return (CLASS_RANK.get(cls, 99), cls)


def activity_of(cls: str) -> str:
    return {"Percussion": "percussion", "Winds": "winds"}.get(cls.split()[0], "guard")


def assemble(store: dict, updated: str) -> None:
    years = sorted(int(y) for y in store["years"])
    (DOCS / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS / "corps").mkdir(exist_ok=True)
    (DOCS / "db").mkdir(exist_ok=True)
    (DOCS / "captions").mkdir(exist_ok=True)

    perfs: dict[tuple[str, str], list[dict]] = {}
    season_files: dict[int, list] = {}
    caption_files: dict[int, list] = {}
    champions: dict[str, dict] = {}
    finals_by_cls_year: dict[str, dict[str, list]] = {}
    db_rows = []
    for year in years:
        season_events = []
        cap_rows = []
        champ_pick: dict[str, dict] = {}  # class -> latest champ event holding it
        for ev in sorted(store["years"][str(year)], key=lambda e: (e["date"], e["name"])):
            for c in ev["classes"]:
                for r in c["results"]:
                    perfs.setdefault((c["class"], r["corps"]), []).append(
                        {"y": year, "d": ev["date"], "ev": ev["name"], "cls": c["class"],
                         "p": r["place"], "s": r["score"], "champ": bool(ev.get("champ"))})
                    db_rows.append([year, ev["date"], ev["name"], r["corps"],
                                    c["class"], r["place"], r["score"]])
                if ev.get("champ") and c["results"]:
                    champ_pick[c["class"]] = ev  # events walked in date order
            for cls, rows in (ev.get("captions") or {}).items():
                for r in rows:
                    cap_rows.append([ev["date"], ev["name"], cls, *r])
            season_events.append({
                "name": ev["name"], "date": ev["date"],
                "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
                "location": ev.get("venue"), "url": ev.get("url"), "source": "competitionsuite",
                "classes": ev["classes"], "has_recap": False,
            })
        season_files[year] = season_events
        cap_rows.sort(key=lambda r: (r[0], r[1], r[2], -r[9]))
        caption_files[year] = cap_rows
        for cls, ev in champ_pick.items():
            res = next(c["results"] for c in ev["classes"] if c["class"] == cls)
            champions.setdefault(str(year), {})[cls] = {
                "corps": res[0]["corps"], "score": res[0]["score"]}
            finals_by_cls_year.setdefault(cls, {})[str(year)] = [
                [r["corps"], r["score"]] for r in res]

    latest = years[-1]
    classes = sorted({cls for cls, _ in perfs}, key=class_sort_key)
    standings = {}
    for cls in classes:
        rows = []
        for (c, name), hist in perfs.items():
            if c != cls:
                continue
            season_hist = sorted((p for p in hist if p["y"] == latest),
                                 key=lambda p: p["d"])
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
            ({"a": rows[i - 1]["corps"], "b": r["corps"], "ra": rows[i - 1]["rank"],
              "rb": r["rank"], "sa": rows[i - 1]["score"], "sb": r["score"],
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
    slug_used: dict[str, str] = {}
    for name in sorted(by_name):
        plist = by_name[name]
        sl = slugify(name)
        while sl in slug_used and slug_used[sl] != name:
            sl += "-2"
        slug_used[sl] = name
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
        act = {"guard": "color guard", "percussion": "indoor percussion",
               "winds": "winds"}[activity_of(cls_now)]
        titles = sorted(y for y, cl in champions.items()
                        if any(v.get("corps") == name for v in cl.values()))
        profiles[sl] = {
            "title": name,
            "img": monogram(name),
            "summary": f"{name} competes in WGASC {cls_now} ({act}). "
            + (f"WGASC class champion: {', '.join(titles)}. " if titles else "")
            + f"Scores from official WGASC recaps, {yrs[0]}–{yrs[-1]}.",
        }
    idx.sort(key=lambda c: c["name"])

    records = {}
    for cls in classes:
        flat = [(n, p) for (c, n), pl in perfs.items() if c == cls for p in pl]
        top = sorted(flat, key=lambda t: -t[1]["s"])[:10]
        records[cls] = {"top": [[p["y"], p["d"], n, p["s"], p["ev"]] for n, p in top],
                        "finals": finals_by_cls_year.get(cls, {})}

    by_decade: dict[str, list] = {}
    for row in db_rows:
        by_decade.setdefault(f"{row[0] // 10 * 10}s", []).append(row)

    # files a live rebuild does not cover must not survive it
    for p in (DOCS / "seasons").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in years:
            p.unlink()
    for p in (DOCS / "corps").glob("*.json"):
        if p.stem not in slug_used:
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
    cap_years = [y for y in years if caption_files.get(y)]
    w("captions/index.json", {
        "seasons": [{"year": y, "rows": len(caption_files[y])} for y in cap_years],
        "cols": ["date", "event", "class", "corps", "ea", "ma", "da", "ge", "pen", "tot"]})
    for y in cap_years:
        w(f"captions/{y}.json", caption_files[y])
    (DOCS / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"wgasc: wrote {sum(len(v) for v in season_files.values())} events across {years}, "
        f"{sum(len(v['rows']) for v in standings.values())} standings rows, "
        f"{len(idx)} ensembles, {sum(len(v) for v in caption_files.values())} caption rows")


# ---------------------------------------------------------------------------

def load_store() -> dict:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text())
        except Exception:  # noqa: BLE001
            pass
    return {"years": {}}


def run_ingest(years: list[int], *, captions: bool = True) -> int:
    store = load_store()
    ok = 0
    for year in years:
        events = ingest_season(year, captions=captions)
        if events:
            store["years"][str(year)] = events
            ok += 1
    if not ok or not store["years"]:
        log("wgasc: nothing ingested — dataset untouched")
        return 1
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ingest", action="store_true", help="pull season(s) and rebuild dataset")
    ap.add_argument("--assemble", action="store_true", help="rebuild dataset from the store only")
    ap.add_argument("--year", type=int, default=None)
    ap.add_argument("--all", action="store_true", help="every known season")
    ap.add_argument("--no-captions", action="store_true", help="skip recap caption pages")
    args = ap.parse_args()
    if args.assemble:
        store = load_store()
        if not store["years"]:
            log("wgasc: empty store")
            return 1
        assemble(store, store.get("updated") or
                 datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
        return 0
    if args.ingest:
        years = sorted(SEASONS) if (args.all or args.year is None) else [args.year]
        return run_ingest(years, captions=not args.no_captions)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
