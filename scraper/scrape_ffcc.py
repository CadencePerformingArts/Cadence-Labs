#!/usr/bin/env python3
"""FFCC (Florida Federation of Colorguards Circuit) live ingest — color guard,
indoor percussion AND winds (~220 member ensembles, one association).

Two mechanisms (both probed live, see data/circuit-probes/winterguard-west.md):

1. Bridge era, 2022-2026: FFCC publishes every recap through CompetitionSuite.
   No public organization GUID exists, but season GUIDs unlock everything:
   GetCompetitionsBySeason(season) -> the season's competitions ->
   GetCompetition(competition) -> rounds {name, performances[name/score/rank],
   fullRecapUrl}. Scores and ranks come straight from the bridge JSON; each
   round's recap .htm carries the judge caption sheet, parsed here for all
   four FFCC sheet layouts (guard EA/Movement/DA/GE, percussion E-Music/
   E-Visual/Music/Visual, concert percussion Music/Artistry, winds Overall
   Effect/Music Analysis/Visual Analysis) into one DCI-format captions DB.
   2024-2026 GUIDs were seeded from Google-indexed schedule links; 2022/2023
   were recovered from Wayback copies of ffcc.org event pages (each embeds its
   schedules.competitionsuite.com GUID, which doubles as the competition GUID).

2. Archive era, ~2008-2021: ffcc.org's own inline score pages, preserved by
   the Wayback Machine. Two formats: WordPress-era /scores/, /colorguard-
   scores/, /percussion-scores/, /winds-scores/ ?eventID=N pages (clean
   `scoreRoundSummary` tables with ensemble/score/place, 2015-2021) and the
   old /events/scores.php?eventcode=N pages (2007-2012). Coverage is whatever
   the archive captured — real but not guaranteed complete.

Usage:
  --ingest --year Y     pull one bridge season into the store + rebuild
  --ingest --all        every bridge season (2022..2026) + rebuild
  --wayback             (re)ingest the Wayback archive eras + rebuild
  --assemble            rebuild docs/ffcc/data/ from the existing store only

Honesty & care: every request goes through the shared rate-limited, gzip-
cached fetch(); reruns are free. Validation gates: plausible score bounds,
ranks recomputed so they are sequential by construction, no duplicate
ensemble rows (dict-merged), caption rows must reconcile arithmetically AND
match the bridge total — otherwise dropped and logged. A failed season never
erases previously published data.
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

DOCS = ROOT / "docs" / "ffcc" / "data"
STORE = DOCS / "live_store.json"
BRIDGE = cs.BRIDGE

# Season GUIDs. 2024-2026 from the probe (Google-indexed schedule links);
# 2022/2023 recovered from Wayback snapshots of ffcc.org/event/* pages and
# resolved live through GetCompetition -> seasonGuid (org initials FFCC on
# every GetCompetitionsBySeason response). Pre-2022 the circuit published
# inline scores on ffcc.org (see the Wayback ingest below).
SEASONS = {
    2022: "14d44e8a-4213-44a2-8b0b-be49cda45d64",   # "2022 FFCC Indoor", 40 comps
    2023: "c03a5ae3-1d76-4340-90c2-1a96f593d935",   # "2023 FFCC Indoor", 29 comps
    2024: "f263a5ec-7f64-4a69-b3ad-5f58913bc697",   # "2024 FFCC Indoor", 25 comps
    2025: "b4ab4a18-9032-4d96-81ea-0be91abc5ae9",   # "2025 FFCC Indoor", 30 comps
    2026: "bfc650fc-d8a1-4104-82e3-536e41a96a6f",   # "2026 FFCC Indoor", 27 comps
}

# The circuit's real classes (surveyed across every round name, 2022-2026,
# plus the archive eras). Display order: guard first (the circuit's headline
# activity), then percussion, then winds — class names carry the activity.
GUARD_CLASSES = [
    "Independent World", "Independent Open", "Independent A",
    "Scholastic World", "Scholastic Open", "Scholastic AAA",
    "Scholastic AA", "Scholastic A", "Regional A",
    "Cadet", "Cadet Novice",
    # archive-era guard classes no longer contested
    "Class B", "Novice Exploration",
]
PERC_CLASSES = [
    "Percussion Independent World", "Percussion Independent Open",
    "Percussion Independent A",
    "Percussion Scholastic World", "Percussion Scholastic Open",
    "Percussion Scholastic AA", "Percussion Scholastic A",
    "Percussion Scholastic Novice",
    "Percussion Scholastic Concert World", "Percussion Scholastic Concert Open",
    "Percussion Scholastic Concert A",
]
WINDS_CLASSES = [
    "Winds Independent World", "Winds Independent Open", "Winds Independent A",
    "Winds Scholastic World", "Winds Scholastic Open", "Winds Scholastic A",
]
CLASS_ORDER = GUARD_CLASSES + PERC_CLASSES + WINDS_CLASSES
CLASS_RANK = {c: i for i, c in enumerate(CLASS_ORDER)}

SCORE_MIN, SCORE_MAX = 5.0, 100.0
WAYBACK_MAX_YEAR = 2021          # bridge era starts 2022 — never overlap
FIRST_YEAR = 2004                # sanity floor for archive dates


def bridge_json(endpoint: str, *, force: bool = False):
    """Bridge GET honoring the on-disk cache — finished seasons never change,
    so reruns are free. force=True re-fetches (season in progress)."""
    txt = fetch(f"{BRIDGE}/{endpoint}", force=force, accept_json=True)
    if txt is None and force:
        txt = fetch(f"{BRIDGE}/{endpoint}", accept_json=True)
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
ROUND_SUFFIX2 = re.compile(r"\s+Round\s*\d+\s*$", re.I)
SKIP_ROUNDS = re.compile(r"exhibition|classification|critique|clinic|solo|duet", re.I)

# archive-era token expansions (order matters: longest first)
_EXPAND = [
    (re.compile(r"^Sch\b"), "Scholastic"),
    (re.compile(r"^Ind\b"), "Independent"),
    (re.compile(r"\bSRA\b"), "Regional A"),
]
# archive-era percussion/winds titles -> modern bridge-era class names
_ARCHIVE_MAP = {
    "Scholastic Regional A": "Regional A",       # SRA == today's Regional A
    "Cadet Regional A": "Cadet",                 # 2021 combined-name rounds
    "Class B Regional A": "Class B",
    "Novice": "Cadet Novice",                    # pre-2016 name (MS novice)
}


def _norm_round_title(s: str) -> str:
    s = norm_space(htmllib.unescape(s or ""))
    s = ROUND_SUFFIX.sub("", s)
    s = ROUND_SUFFIX2.sub("", s)
    return norm_space(s)


def norm_class_bridge(round_name: str) -> str | None:
    """Bridge round label -> circuit class, or None for non-competitive.
    'Scholastic AAA (Round 2)' -> 'Scholastic AAA'; flight/division splits
    like 'Regional A (Illusion Division)' or 'Percussion Scholastic A
    (McCormick's Division)' union into their base class (championship
    divisions are parallel flights of one class)."""
    s = _norm_round_title(round_name)
    if not s or SKIP_ROUNDS.search(s):
        return None
    if s in CLASS_RANK:
        return s
    m = re.match(r"^(.*?)\s*\([^)]*\)$", s)
    if m and norm_space(m.group(1)) in CLASS_RANK:
        return norm_space(m.group(1))
    return s  # unknown label — caller logs and skips


def norm_class_archive(round_name: str, page_kind: str) -> str | None:
    """Archive-era round title -> modern class name. page_kind gives the
    activity when the title omits it ('cg' | 'perc' | 'winds' | 'any')."""
    s = _norm_round_title(round_name)
    if not s or SKIP_ROUNDS.search(s):
        return None
    for rx, rep in _EXPAND:
        s = rx.sub(rep, s)
    s = norm_space(s)
    # activity tokens embedded in the title win over page kind
    if re.search(r"\bMarching\b", s):
        s = norm_space("Percussion " + s.replace("Marching", ""))
    elif re.search(r"\bConcert\b", s) and page_kind in ("perc", "any"):
        # 'Concert A' -> 'Percussion Scholastic Concert A'
        s = norm_space(re.sub(r"^(?:Percussion )?(?:Scholastic )?Concert",
                              "Percussion Scholastic Concert", s))
    elif re.search(r"\bWinds\b", s):
        # 'Scholastic Winds A' / 'Independent Winds World' -> Winds first
        s = norm_space("Winds " + s.replace("Winds", ""))
    elif page_kind == "perc":
        s = "Percussion " + s
    elif page_kind == "winds":
        s = "Winds " + s
    s = _ARCHIVE_MAP.get(s, s)
    if s in CLASS_RANK:
        return s
    m = re.match(r"^(.*?)\s*\([^)]*\)$", s)
    if m and norm_space(m.group(1)) in CLASS_RANK:
        return norm_space(m.group(1))
    return s  # unknown label — caller logs and skips


def norm_name(name: str) -> str:
    n = norm_space(htmllib.unescape(name or ""))
    n = n.replace("’", "'").replace("‘", "'")
    return n.rstrip("*+^~, ")


CHAMP_RE = re.compile(r"championship", re.I)


def is_champ(comp_name: str) -> bool:
    return bool(CHAMP_RE.search(comp_name))


# ---------------------------------------------------------------------------
# recap caption parsing — all four FFCC sheet layouts
# ---------------------------------------------------------------------------
# Sheet header rows: caption groups (class 'captionTotal', colspan = leaf
# cells) / judges ('subcaptionTotal') / leaf columns; then one <tr> per
# ensemble whose score cells align with the leaf columns plus Sub Total /
# Pen / Total. Regionals run one judge per caption (caption total = the
# judge's Tot cell); championships double the panels and append a combined
# total cell per group — in both layouts the caption total is the LAST cell
# of its group. Identical mechanics to the WGASC/TCGC sheets; only the
# caption names differ per activity.

CAPTION_KEYS = {
    "equipment analysis": "ea",
    "movement": "ma",
    "movement analysis": "ma",
    "design analysis": "da",
    "general effect": "ge",
    "effect - music": "em",
    "effect-music": "em",
    "effect - visual": "ev",
    "effect-visual": "ev",
    "music": "mus",
    "visual": "vis",
    "overall effect": "oe",
    "music analysis": "ma",     # winds sheet
    "visual analysis": "va",
    "artistry": "art",
    "timing & penalties": "pen",
    "timing &amp; penalties": "pen",
}
# recognized sheets: ordered caption keys (pen excluded) -> sheet id
SHEET_LAYOUTS = {
    ("ea", "ma", "da", "ge"): "guard",
    ("em", "ev", "mus", "vis"): "perc",
    ("mus", "art"): "concert",
    ("oe", "ma", "va"): "winds",
}
# superset caption columns written to docs (order = display order)
CAPTION_COLS = ["ge", "ea", "ma", "da", "em", "ev", "mus", "vis", "oe", "va", "art"]

_GROUP_CELL = re.compile(
    r"<td (?:colspan='(\d+)' )?class='[^']*\bcaptionTotal\b[^']*'[^>]*>([^<]*)</td>")
_NAME_CELL = re.compile(  # ensemble cell, optionally followed by a location cell
    r"<td class='content topBorder rightBorderDouble'[^>]*>([^<]+)</td>\s*"
    r"(?:<td class='content topBorder rightBorderDouble'[^>]*>[^<]*</td>)?", re.I)
_SCORE_CELL = re.compile(
    r"<td class='(?:content )?(?:topBorder )?[^']*'[^>]*>\s*"
    r"<table class='scoreTable'.*?data-translate-number='([^']*)'.*?</table>\s*</td>", re.S)


def _num(raw: str) -> float | None:
    raw = (raw or "").strip()
    if raw in ("", "--", "-"):
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return None


def parse_recap_sheet(html: str) -> list[dict] | None:
    """One recap page -> [{corps, caps:{key: total}, pen, tot}] for any of the
    four FFCC sheet layouts, or None when the sheet isn't recognized."""
    anchors = list(_NAME_CELL.finditer(html))
    if not anchors:
        return None
    head = html[:anchors[0].start()]

    groups: list[tuple[str, int]] = []
    for span, label in _GROUP_CELL.findall(head):
        key = CAPTION_KEYS.get(norm_space(htmllib.unescape(label)).lower())
        if key:
            groups.append((key, int(span or 1)))
    layout = tuple(k for k, _ in groups if k != "pen")
    if layout not in SHEET_LAYOUTS or not groups or groups[-1][0] != "pen":
        return None
    n_caption_cells = sum(s for k, s in groups if k != "pen")
    expected = n_caption_cells + 3  # + Sub Total + Pen + Total
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
        caps = {key: cells[idx] for key, idx in total_idx.items()}
        pen, tot = cells[pen_idx], cells[tot_idx]
        if abs(sum(caps.values()) - pen - tot) > 0.015:
            # some sheets print the penalty outside the parsed cells — derive
            # it from the printed total instead (still bounded + cent-exact)
            derived = round(sum(caps.values()) - tot, 3)
            if 0 < derived <= 15.05 and abs(derived - round(derived, 2)) < 1e-9:
                pen = derived
            else:
                log(f"    caption row dropped ({corps}): "
                    f"{sum(caps.values()) - pen:.3f} != {tot}")
                continue
        rows.append({"corps": corps, "caps": caps, "pen": pen, "tot": tot})
    return rows or None


# ---------------------------------------------------------------------------
# bridge-era season ingest
# ---------------------------------------------------------------------------

def _merge_round(cls_map: dict, cls: str, perfs: list[dict], eid: str) -> None:
    """Accumulate one round into the event's class map, keeping each
    ensemble's best outing (Round 1/2 flights and championship divisions of
    one class union; prelims+finals in one comp keep the better score)."""
    best = cls_map.setdefault(cls, {})
    for p in perfs:
        score, name = p.get("score"), norm_name(p.get("name") or "")
        if score is None or not name:
            continue
        score = round(float(score), 3)
        if not (SCORE_MIN <= score <= SCORE_MAX):
            log(f"    {eid} [{cls}] dropped {name} ({score}) — score out of range")
            continue
        if name not in best or score > best[name]:
            best[name] = score


def ingest_season(year: int, *, captions: bool = True) -> list[dict] | None:
    sg = SEASONS[year]
    season = bridge_json(f"GetCompetitionsBySeason/jsonp?season={sg}")
    if not season or season.get("organizationInitials") != "FFCC":
        log(f"ffcc {year}: season list unavailable or wrong org — skipping")
        return None
    comps = season.get("competitions") or []
    events: dict[tuple[str, str], dict] = {}
    n_rounds = n_rows = 0
    for comp in sorted(comps, key=lambda c: c.get("competitionDate") or ""):
        guid = comp.get("competitionGuid")
        date = (comp.get("competitionDate") or "")[:10]
        if not guid or not re.match(r"\d{4}-\d{2}-\d{2}$", date) or int(date[:4]) != year:
            continue
        if re.search(r"\btest\b", comp.get("name") or "", re.I):
            log(f"  {year} {date} skipped test event: {comp.get('name')}")
            continue
        detail = bridge_json(f"GetCompetition/jsonp?competition={guid}")
        if not detail:
            log(f"  {year} {date} {comp.get('name')}: GetCompetition failed — skipped")
            continue
        name = norm_space(htmllib.unescape(comp.get("name") or "Competition"))
        key = (date, name)
        ev = events.setdefault(key, {
            "name": name, "date": date,
            "venue": norm_space(comp.get("location") or "") or None,
            "url": f"https://recaps.competitionsuite.com/{guid}.htm",
            "champ": is_champ(name),
            "cls_map": {}, "cap_map": {},
        })
        for rnd in detail.get("rounds") or []:
            cls = norm_class_bridge(rnd.get("name") or "")
            if cls is None:
                continue
            if cls not in CLASS_RANK:
                log(f"  {year} {date} [{rnd.get('name')}] — unknown class, skipped")
                continue
            perfs = rnd.get("performances") or []
            if not perfs:
                continue
            _merge_round(ev["cls_map"], cls, perfs, f"{date} {name}")
            n_rounds += 1
            url = (rnd.get("fullRecapUrl") or "").replace("http://", "https://")
            if captions and url:
                html = fetch(url, retries=1)
                cap_rows = parse_recap_sheet(html) if html else None
                if cap_rows:
                    ev["cap_map"].setdefault(cls, []).extend(cap_rows)

    out = []
    for (date, name), ev in sorted(events.items()):
        classes = []
        for cls in sorted(ev["cls_map"], key=lambda c: CLASS_RANK[c]):
            ranked = sorted(ev["cls_map"][cls].items(), key=lambda kv: (-kv[1], kv[0]))
            if not ranked:
                continue
            classes.append({"class": cls, "results": [
                {"place": i + 1, "corps": n, "score": s} for i, (n, s) in enumerate(ranked)]})
            n_rows += len(ranked)
        if not classes:
            continue
        # caption cross-check: recap total must equal the bridge score. An
        # unmatched name falls back to a UNIQUE-total join within the class
        # and adopts the bridge (published) name; ambiguity drops the row.
        captions_out = {}
        for cls, rows in ev["cap_map"].items():
            by_name = {r["corps"]: r["score"]
                       for c in classes if c["class"] == cls for r in c["results"]}
            keep, seen = [], set()
            for r in rows:
                corps, bridge_s = r["corps"], by_name.get(r["corps"])
                if bridge_s is None or abs(bridge_s - r["tot"]) > 0.011:
                    cands = [n for n, s in by_name.items()
                             if n not in seen and abs(s - r["tot"]) <= 0.011]
                    if bridge_s is None and len(cands) == 1:
                        corps = cands[0]
                    else:
                        log(f"    {date} {name} [{cls}] caption row dropped "
                            f"({r['corps']}): recap {r['tot']} vs bridge {bridge_s}")
                        continue
                if corps in seen:
                    continue
                seen.add(corps)
                keep.append({"corps": corps, "caps": r["caps"],
                             "pen": r["pen"], "tot": r["tot"]})
            if keep:
                captions_out[cls] = keep
        out.append({"name": name, "date": date, "venue": ev["venue"], "url": ev["url"],
                    "champ": ev["champ"], "classes": classes, "captions": captions_out})

    n_caps = sum(len(v) for e in out for v in e["captions"].values())
    log(f"ffcc {year}: {len(out)} events, {n_rounds} rounds, {n_rows} result rows, "
        f"{n_caps} caption rows")
    if len(out) < 12 or n_rows < 300:
        log(f"ffcc {year}: validation FAILED (events/rows below floor) — season not stored")
        return None
    return out


# ---------------------------------------------------------------------------
# Wayback archive ingest (~2008-2021)
# ---------------------------------------------------------------------------

CDX = "https://web.archive.org/cdx/search/cdx"
WB_PAGES = [  # (path prefix, activity kind when round titles omit it)
    ("ffcc.org/scores/", "any"),
    ("ffcc.org/colorguard-scores/", "cg"),
    ("ffcc.org/percussion-scores/", "perc"),
    ("ffcc.org/winds-scores/", "winds"),
]
_WB_TITLE = re.compile(r'class="eventTitle">\s*([^<]*?)\s*</')
_WB_DATE = re.compile(r'class="eventDate">\s*([^<]*?)\s*</')
_WB_ROUND = re.compile(
    r'class="showRoundTitle"[^>]*>\s*([^<]*?)\s*</h3>\s*'
    r'<table class="scoreRoundSummary"[^>]*>(.*?)</table>', re.S)
_WB_ROW = re.compile(  # 2021-era cells carry style/data-ensembleid attrs
    r"<td class=['\"]ensembleName left['\"][^>]*>\s*([^<]*?)\s*</td>\s*"
    r"<td class=['\"]totalScore center['\"][^>]*>([^<]*)</td>")
_PHP_TITLE = re.compile(r'font-size:\s*20px[^>]*>([^<]+)</span>')
_PHP_DATE = re.compile(r'(\d{2}/\d{2}/\d{4})\s*<br')
_PHP_CLASS = re.compile(r'colspan=2><b><font color="#000099">([^<]+)</font>')
_PHP_ROW = re.compile(
    r'width=32 [Nn]owrap>(\d+)</td>\s*<td[^>]*>([^<]+)</td>\s*'
    r'<td[^>]*><b>([\d.]+)</b>')


def _cdx_latest(prefix: str) -> list[tuple[str, str]]:
    """Latest 200-status snapshot per distinct ?eventID page under prefix."""
    url = (f"{CDX}?url={quote(prefix, safe='')}&matchType=prefix"
           f"&fl=urlkey,timestamp,original,statuscode&filter=statuscode:200")
    txt = fetch(url, retries=2, timeout=60)
    best: dict[str, tuple[str, str]] = {}
    for line in (txt or "").splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        uk, ts, orig = parts[0], parts[1], parts[2]
        if not re.search(r"eventid=\d+$", uk):
            continue
        if uk not in best or ts > best[uk][0]:
            best[uk] = (ts, orig)
    return sorted(best.values())


def _parse_date(raw: str) -> str | None:
    raw = norm_space(raw)
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _wb_snapshot_url(ts: str, orig: str) -> str:
    return f"https://web.archive.org/web/{ts}id_/{orig}"


def ingest_wayback() -> dict[int, list[dict]]:
    """All archive-era events, grouped by season year. Events keyed by
    (date, title) so the same show fetched from /scores/ and an activity page
    merges; duplicated shortcode blocks on one page dedupe the same way."""
    events: dict[tuple[str, str], dict] = {}
    unknown: dict[str, int] = {}

    def merge_rows(key, cls, rows, eid):
        perfs = [{"name": n, "score": _num(s)} for n, s in rows]
        perfs = [p for p in perfs if p["score"]]
        if perfs:
            _merge_round(events[key]["cls_map"], cls, perfs, eid)

    n_pages = 0
    for prefix, kind in WB_PAGES:
        snaps = _cdx_latest(prefix)
        log(f"ffcc wayback: {prefix} — {len(snaps)} archived event pages")
        for ts, orig in snaps:
            html = fetch(_wb_snapshot_url(ts, orig), retries=1, timeout=60)
            if not html:
                continue
            t, d = _WB_TITLE.search(html), _WB_DATE.search(html)
            if not t or not d:
                continue
            title = norm_name(t.group(1))
            date = _parse_date(d.group(1))
            if not title or not date:
                continue
            year, month = int(date[:4]), int(date[5:7])
            if not (FIRST_YEAR <= year <= WAYBACK_MAX_YEAR) or month > 6:
                continue  # fall/outdoor events are not the indoor circuit
            key = (date, title)
            events.setdefault(key, {
                "name": title, "date": date, "venue": None,
                "url": f"https://web.archive.org/web/{ts}/{orig}",
                "champ": is_champ(title), "cls_map": {}, "cap_map": {},
            })
            got = 0
            for rt, block in _WB_ROUND.findall(html):
                cls = norm_class_archive(rt, kind)
                if cls is None:
                    continue
                if cls not in CLASS_RANK:
                    unknown[cls] = unknown.get(cls, 0) + 1
                    continue
                rows = _WB_ROW.findall(block)
                merge_rows(key, cls, rows, f"{date} {title}")
                got += 1
            if got:
                n_pages += 1

    # oldest era: /events/scores.php?...eventcode=N (2007-2012)
    for prefix in ("ffcc.org/events/scores.php", "ffcc.org/scores.php"):
        url = (f"{CDX}?url={quote(prefix, safe='')}&matchType=prefix"
               f"&fl=urlkey,timestamp,original,statuscode&filter=statuscode:200")
        txt = fetch(url, retries=2, timeout=60)
        best: dict[str, tuple[str, str]] = {}
        for line in (txt or "").splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            uk, ts, orig = parts[0], parts[1], parts[2]
            m = re.search(r"eventcode=(\d+)", uk)
            if not m:
                continue
            if uk not in best or ts > best[uk][0]:
                best[uk] = (ts, orig)
        log(f"ffcc wayback: {prefix} — {len(best)} archived event pages")
        for ts, orig in sorted(best.values()):
            html = fetch(_wb_snapshot_url(ts, orig), retries=1, timeout=60)
            if not html:
                continue
            t, d = _PHP_TITLE.search(html), _PHP_DATE.search(html)
            if not t or not d:
                continue
            title = norm_name(re.sub(r"\s*Results\s*$", "", t.group(1)))
            date = _parse_date(d.group(1))
            if not title or not date:
                continue
            year, month = int(date[:4]), int(date[5:7])
            if not (FIRST_YEAR <= year <= WAYBACK_MAX_YEAR) or month > 6:
                continue
            key = (date, title)
            events.setdefault(key, {
                "name": title, "date": date, "venue": None,
                "url": f"https://web.archive.org/web/{ts}/{orig}",
                "champ": is_champ(title), "cls_map": {}, "cap_map": {},
            })
            # class headers partition the row list by position
            marks = [(m.start(), norm_space(m.group(1))) for m in _PHP_CLASS.finditer(html)]
            got = 0
            for i, (pos, label) in enumerate(marks):
                end = marks[i + 1][0] if i + 1 < len(marks) else len(html)
                cls = norm_class_archive(label, "cg")
                if cls is None:
                    continue
                if cls not in CLASS_RANK:
                    unknown[cls] = unknown.get(cls, 0) + 1
                    continue
                rows = [(n, s) for _, n, s in _PHP_ROW.findall(html[pos:end])]
                merge_rows(key, cls, rows, f"{date} {title}")
                got += 1
            if got:
                n_pages += 1

    for cls, n in sorted(unknown.items(), key=lambda kv: -kv[1]):
        log(f"ffcc wayback: unknown class skipped ×{n}: {cls}")

    by_year: dict[int, list[dict]] = {}
    n_rows = 0
    for (date, name), ev in sorted(events.items()):
        classes = []
        for cls in sorted(ev["cls_map"], key=lambda c: CLASS_RANK[c]):
            ranked = sorted(ev["cls_map"][cls].items(), key=lambda kv: (-kv[1], kv[0]))
            if not ranked:
                continue
            classes.append({"class": cls, "results": [
                {"place": i + 1, "corps": n, "score": s} for i, (n, s) in enumerate(ranked)]})
            n_rows += len(ranked)
        if not classes:
            continue
        by_year.setdefault(int(date[:4]), []).append(
            {"name": name, "date": date, "venue": None, "url": ev["url"],
             "champ": ev["champ"], "classes": classes, "captions": {}})
    log(f"ffcc wayback: {n_pages} pages -> {sum(len(v) for v in by_year.values())} events, "
        f"{n_rows} rows across {sorted(by_year)}")
    return by_year


# ---------------------------------------------------------------------------
# dataset assembly — the exact shared-pipeline format (see scrape_usbands.py)
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    base = re.sub(r"\s*\([^)]*\)$", "", name)
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
                    caps = r.get("caps") or {}
                    cap_rows.append([ev["date"], ev["name"], cls, r["corps"],
                                     *[caps.get(k) for k in CAPTION_COLS],
                                     r["pen"], r["tot"]])
            season_events.append({
                "name": ev["name"], "date": ev["date"],
                "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
                "location": ev.get("venue"), "url": ev.get("url"),
                "source": "competitionsuite" if year >= min(SEASONS) else "ffcc.org (Wayback)",
                "classes": ev["classes"], "has_recap": False,
            })
        season_files[year] = season_events
        cap_rows.sort(key=lambda r: (r[0], r[1], r[2], -r[-1]))
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
            "summary": f"{name} competes in FFCC {cls_now} ({act}). "
            + (f"FFCC class champion: {', '.join(titles)}. " if titles else "")
            + f"Scores from official FFCC results, {yrs[0]}–{yrs[-1]}.",
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

    # files a rebuild does not cover must not survive it
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
        "cols": ["date", "event", "class", "corps", *CAPTION_COLS, "pen", "tot"]})
    for y in cap_years:
        w(f"captions/{y}.json", caption_files[y])
    for p in (DOCS / "captions").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in cap_years:
            p.unlink()
    (DOCS / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"ffcc: wrote {sum(len(v) for v in season_files.values())} events across "
        f"{years[0]}–{years[-1]}, {sum(len(v['rows']) for v in standings.values())} standings rows, "
        f"{len(idx)} ensembles, {sum(len(v) for v in caption_files.values())} caption rows")


# ---------------------------------------------------------------------------

def load_store() -> dict:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text())
        except Exception:  # noqa: BLE001
            pass
    return {"years": {}}


def _finish(store: dict) -> int:
    if not store["years"]:
        log("ffcc: nothing ingested — dataset untouched")
        return 1
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    return 0


def run_ingest(years: list[int], *, captions: bool = True) -> int:
    store = load_store()
    ok = 0
    for year in years:
        events = ingest_season(year, captions=captions)
        if events:
            store["years"][str(year)] = events
            ok += 1
    if not ok:
        log("ffcc: no season ingested — dataset untouched")
        return 1
    return _finish(store)


def run_wayback() -> int:
    store = load_store()
    by_year = ingest_wayback()
    for year, events in by_year.items():
        if year in SEASONS:
            continue  # bridge data is authoritative for its era
        store["years"][str(year)] = events
    return _finish(store)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ingest", action="store_true", help="pull bridge season(s) and rebuild")
    ap.add_argument("--wayback", action="store_true", help="(re)ingest Wayback archive eras")
    ap.add_argument("--assemble", action="store_true", help="rebuild dataset from the store only")
    ap.add_argument("--year", type=int, default=None)
    ap.add_argument("--all", action="store_true", help="every known bridge season")
    ap.add_argument("--no-captions", action="store_true", help="skip recap caption pages")
    args = ap.parse_args()
    if args.assemble:
        store = load_store()
        if not store["years"]:
            log("ffcc: empty store")
            return 1
        assemble(store, store.get("updated") or
                 datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
        return 0
    rc = 0
    if args.ingest:
        years = sorted(SEASONS) if (args.all or args.year is None) else [args.year]
        rc = run_ingest(years, captions=not args.no_captions)
    if args.wayback:
        rc = run_wayback() or rc
    if not args.ingest and not args.wayback:
        ap.print_help()
        return 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
