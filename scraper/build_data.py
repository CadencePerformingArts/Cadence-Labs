"""Build the static site's data (docs/data) from DCI.org scrape output ONLY.

Input:  data/parsed/dci_events.json
Output: docs/data/
  meta.json                dataset stats, seasons list, sources
  rankings.json            current-season standings/movers/battles per class
  champions.json           {year: {class: {corps, score}}} from championship finals
  seasons/<year>.json      full event list w/ results + caption recaps
  corps_index.json         per-corps summary + season-best series
  corps/<slug>.json        every performance for one corps
  db/perfs_<decade>s.json  flat sortable rows + db/index.json
  records.json             all-time record-book inputs (top scores, finals)
  caption_titles.json      per-year caption winners at championship finals
  recaps/<year>.json       judge-level recap sheets (values + official ranks)
"""
from __future__ import annotations

import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timezone

from common import ROOT, OUT, write_json, log, norm_space, canon_corps, slugify

PARSED = ROOT / "data" / "parsed"

MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}


def iso_date(ev) -> str | None:
    d = ev.get("date_display")
    if not d:
        return None
    m = re.match(r"(\w+)\s+(\d{1,2}),?\s+(\d{4})", d)
    if not m or m.group(1) not in MONTHS:
        return None
    return f"{int(m.group(3)):04d}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}"


CLASS_CANON = [
    (re.compile(r"all\s*-?\s*age|^sr\.?$|^senior", re.I), "All-Age"),
    (re.compile(r"world class|division i\b", re.I), "World Class"),
    (re.compile(r"open class|division ii", re.I), "Open Class"),
    (re.compile(r"international", re.I), "International"),
    (re.compile(r"ex[h]?ib|soundsport|mini|^exh\.?$|rain(ed)?\s*-?\s*out|^rainout$", re.I), "Exhibition"),
    # historical junior-corps division systems (pre-DCI-class era)
    (re.compile(r"^(class\s*)?a$|^a\s+class$|^junior a$", re.I), "Class A"),
    (re.compile(r"^(class\s*)?b$|^b\s+class$|^junior b$", re.I), "Class B"),
    (re.compile(r"^(class\s*)?c$|^c\s+class$|^junior c$", re.I), "Class C"),
    (re.compile(r"all[- ]?girl", re.I), "All-Girl"),
    (re.compile(r"^(jr\.?|junior)s?(\s+class)?$", re.I), "Junior"),
    # bare division numerals from archive listings
    (re.compile(r"^(div\.?|division|us)?\s*(i|1)$|^dci$", re.I), "World Class"),
    (re.compile(r"^(div\.?|division|us)?\s*(ii|2|iii|3|iv|4)$|^ii\s*/?\s*iii$|^us ii/iii$", re.I), "Open Class"),
]

# Individual & Ensemble contest categories — people, not corps. These must
# never reach corps pages, rankings, or the database.
IE_CLASS = re.compile(
    r"^(brass|woodwind|percussion|visual|vocal|mixed|color ?guard)\s*[-–—]"
    r"|solo\b|ensemble\b|individual", re.I)


def canon_class(name: str) -> str:
    n = norm_space(name or "")
    for pat, out in CLASS_CANON:
        if pat.search(n):
            return out
    return n or "World Class"


def load_events():
    """dci_events.json (DCI.org, 2013+) merged with history_events.json
    (pre-2013 archive scrape, same schema). History only contributes years
    the official source doesn't cover, so DCI.org stays authoritative."""
    events = []
    p = PARSED / "dci_events.json"
    if p.exists():
        events = json.loads(p.read_text())
    dci_years = {e.get("year") for e in events}
    hp = PARSED / "history_events.json"
    if hp.exists():
        hist = [e for e in json.loads(hp.read_text())
                if e.get("year") and (e["year"] < 2013 or e["year"] not in dci_years)]
        events += hist
        log(f"merged {len(hist)} historical events")
    if not events:
        log("no parsed events — nothing to build")
        return []
    NON_FIELD = re.compile(r"mini-?corps|individual\s*&\s*ensemble|\bi\s*&\s*e\b|mca championship", re.I)
    out = []
    for ev in events:
        if not ev.get("year") or not ev.get("classes") or ev.get("non_corps"):
            continue
        if NON_FIELD.search(ev.get("name") or ""):
            continue  # standstill/ensemble contests are not field competition
        ev = dict(ev)
        ev["date"] = ev.get("date") or iso_date(ev)
        classes = []
        for c in ev["classes"]:
            if IE_CLASS.search(norm_space(c.get("class") or "")):
                continue  # individual/ensemble category, not corps competition
            raw_label = norm_space(c.get("class") or "")
            cc = canon_class(raw_label)
            results = [dict(r, corps=canon_corps(r["corps"])) for r in c["results"] if r.get("corps")]
            # junk rows: bare numbers, unknown/tba placeholders
            results = [r for r in results
                       if not re.fullmatch(r"\d+", r["corps"])
                       and r["corps"].lower().strip("()") not in ("unknown", "tba", "tbd", "n/a")]
            # a corps listed twice in one group keeps its best-scored row
            best_row: dict[str, dict] = {}
            for r in results:
                cur = best_row.get(r["corps"])
                if cur is None or (r.get("score") or -1) > (cur.get("score") or -1):
                    best_row[r["corps"]] = r
            results = [r for r in results if best_row[r["corps"]] is r]
            if not results or cc == "Exhibition":
                continue
            entry = {"class": cc, "results": results}
            # sub-divisions ("All-Age - World Class") keep their own group and
            # label so placements stay truthful; aggregations use the canon class
            if raw_label and raw_label != cc:
                entry["label"] = raw_label
            classes.append(entry)
        # merge duplicate groups only when the displayed label also matches
        merged: dict[tuple, dict] = {}
        for c in classes:
            key = (c["class"], c.get("label") or "")
            if key in merged:
                merged[key]["results"].extend(c["results"])
            else:
                merged[key] = c
        for c in merged.values():
            c["results"].sort(key=lambda r: (r["place"] if r["place"] is not None else 99, -(r["score"] or 0)))
        ev["classes"] = list(merged.values())
        if ev["classes"]:
            out.append(ev)

    # placeholder archive names become honest labels
    for ev in out:
        nm = ev.get("name") or ""
        m2 = re.fullmatch(r"Show (#\d+)", nm)
        if m2:
            ev["name"] = f"Unidentified Show {m2.group(1)}"
        elif nm.isupper() and len(nm) > 5:
            ev["name"] = re.sub(r"\b(dci|dca|dcm|dce|dcw|vfw|gsc)\b",
                                lambda mm: mm.group(1).upper(), nm.title(), flags=re.I)

    # duplicate archive listings of the same show (same year, identical
    # scorelines): keep the dated / better-named copy
    def scoreline(ev):
        cells = []
        for c in ev["classes"]:
            for r in c["results"]:
                if r.get("score"):
                    cells.append((r["corps"], r["score"]))
        return frozenset(cells)
    # Two events with the same year, same date, and an identical scoreline are
    # the same show — whether that's an archive double-listing OR the current
    # season's mirrors naming one show differently (CompetitionSuite "DCI
    # Eastern Classic" vs drum-corps.net "DCI Eastern Classic – Friday", both
    # Bluecoats 96.825…). Different-dated shows that merely share a scoreline
    # (prelims vs finals live on different dates/scores) are never merged.
    by_line = defaultdict(list)
    for ev in out:
        line = scoreline(ev)
        if len(line) >= 3:
            by_line[(ev["year"], line)].append(ev)
    drop_ids = set()
    generic = re.compile(r"^unidentified show|show$", re.I)
    for evs in by_line.values():
        if len(evs) < 2:
            continue
        dates = {e.get("date") for e in evs}
        if len([d for d in dates if d]) > 1:
            continue  # genuinely different dated shows that share a scoreline
        # keep the richest, cleanest copy: a judge recap beats none, more
        # results beats fewer, dated beats undated, a real name beats a generic
        # or suffixed one ("… – Friday")
        evs.sort(key=lambda e: (
            not e.get("recap"),
            -sum(len(c.get("results") or []) for c in e.get("classes") or []),
            e.get("date") is None,
            bool(generic.search(e.get("name") or "")),
            len(e.get("name") or ""),
        ))
        keep = evs[0]
        for e in evs[1:]:
            if not keep.get("location") and e.get("location"):
                keep["location"] = e["location"]
            drop_ids.add(id(e))
    if drop_ids:
        out = [e for e in out if id(e) not in drop_ids]
        log(f"deduped {len(drop_ids)} duplicate show listings")

    # The archive's year listings mix the senior (DCA) circuit into the junior
    # divisions. Corps that appear at DCA-named shows in a year are senior
    # corps — every archive result of theirs that year belongs to All-Age,
    # not the DCI World/Open Class record. A curated list catches years where
    # no DCA-named show made the listing.
    KNOWN_ALLAGE = {
        "Reading Buccaneers", "Empire Statesmen", "Minnesota Brass",
        "Connecticut Hurricanes", "Hawthorne Caballeros", "Syracuse Brigadiers",
        "Skyliners", "Sunrisers", "Bushwackers", "Hurricanes",
        "Steel City Ambassadors", "Rochester Crusaders", "Chops, Inc.",
        "Govenaires", "Fitchburg Kingsmen", "White Sabers", "Fusion Core",
        "Cincinnati Tradition", "Atlanta CorpsVets", "Carolina Gold",
    }
    seniors_by_year: dict[int, set] = defaultdict(set)
    for ev in out:
        if ev.get("source") == "dcx" and "dca" in (ev.get("name") or "").lower():
            for c in ev["classes"]:
                for r in c["results"]:
                    seniors_by_year[ev["year"]].add(r["corps"])
    for ev in out:
        if ev.get("source") == "dcx" and "dci" not in (ev.get("name") or "").lower():
            for c in ev["classes"]:
                for r in c["results"]:
                    if r["corps"] in KNOWN_ALLAGE:
                        seniors_by_year[ev["year"]].add(r["corps"])
    moved = 0
    for ev in out:
        if ev.get("source") != "dcx":
            continue
        seniors = seniors_by_year.get(ev["year"])
        if not seniors:
            continue
        extra = None
        for c in ev["classes"]:
            if c["class"] not in ("World Class", "Open Class"):
                continue
            sen = [r for r in c["results"] if r["corps"] in seniors]
            if not sen:
                continue
            c["results"] = [r for r in c["results"] if r["corps"] not in seniors]
            extra = extra or {"class": "All-Age", "results": []}
            extra["results"].extend(sen)
            moved += len(sen)
        if extra:
            ev["classes"] = [c for c in ev["classes"] if c["results"]]
            existing = next((c for c in ev["classes"] if c["class"] == "All-Age"), None)
            if existing:
                existing["results"].extend(extra["results"])
            else:
                ev["classes"].append(extra)
        ev["classes"] = [c for c in ev["classes"] if c["results"]]
    if moved:
        log(f"reclassified {moved} senior-circuit results to All-Age")
    out = [ev for ev in out if ev["classes"]]

    log(f"loaded {len(out)} usable events")
    return out


def build_seasons(events):
    by = defaultdict(list)
    for ev in events:
        by[ev["year"]].append(ev)
    season_index = []
    for year, evs in sorted(by.items()):
        evs.sort(key=lambda e: (e.get("date") or "9999-99-99", e.get("name") or ""))
        # raw recap tables ship no more: their nested-header dumps rendered
        # scrambled; the verified caption breakdown (captions/<year>.json)
        # is the readable, arithmetically-checked version of the same data
        slim = [{
            "name": ev.get("name"), "date": ev.get("date"),
            "date_display": ev.get("date_display"),
            "location": (None if (ev.get("name") or "").lower().startswith((ev.get("location") or "~").lower())
                         else ev.get("location")),
            "url": ev.get("url"), "recap_url": ev.get("recap_url"),
            "source": ev.get("source"),
            "classes": ev.get("classes"),
            "has_recap": bool(ev.get("recap")),
        } for ev in evs]
        write_json(f"seasons/{year}.json", slim)
        season_index.append({"year": year, "events": len(evs)})
    return season_index


def is_champ_finals(ev) -> bool:
    """True when this event crowns a champion. Requires the real
    championships ("World Championship..." / "DCI Championship...") — July
    regionals that borrow the words "Championship Finals" don't count — and
    excludes semis/prelims. The archive's finals are often named plain
    "DCI World Championships" with no "Finals" token, so finals wording is
    not required. Archive events from other circuits (VFW, DCA...) only
    count when DCI is in the name."""
    n = (ev.get("name") or "").lower()
    if "semi" in n or "prelim" in n or "quarter" in n:
        return False
    # side championships crown their own divisions, not the DCI title —
    # the archive labels their sections as the top division, so exclude by name
    if re.search(r"class a\b|all[- ]?girl|division i{2,3}\b", n):
        return False
    # some archive years name the finals bare "World Class Finals" — that
    # phrasing is DCI's own, so it clears the non-DCI-circuit guard
    if re.fullmatch(r"(dci\s+)?(world|open) class finals", n):
        return True
    if ev.get("source") == "dcx" and "dci" not in n:
        return False
    return "world championship" in n or "dci championship" in n


def build_champions(events):
    champs = defaultdict(dict)
    for ev in events:
        if not is_champ_finals(ev):
            continue
        n = (ev.get("name") or "").lower()
        for c in ev["classes"]:
            res = [r for r in c["results"] if r.get("score")]
            if not res:
                continue
            res.sort(key=lambda r: (r["place"] if r["place"] is not None else 99, -(r["score"] or 0)))
            cls = c["class"]
            if "open class" in n and cls == "World Class":
                cls = "Open Class"
            if "all-age" in n or "all age" in n:
                cls = "All-Age"
            cur = champs[ev["year"]].get(cls)
            if cur is None or (res[0]["score"] or 0) > (cur["score"] or 0):
                top = res[0]["score"]
                winners = list(dict.fromkeys(r["corps"] for r in res if r["score"] == top))
                champs[ev["year"]][cls] = {"corps": " & ".join(winners), "score": top}

    # fall back to the documented public record (Wikipedia) for seasons
    # where no championship-finals event has been scraped
    wp = PARSED / "wiki_champions.json"
    if wp.exists():
        filled = 0
        for year, w in json.loads(wp.read_text()).items():
            if "World Class" not in champs[int(year)] and w.get("corps"):
                champs[int(year)]["World Class"] = {"corps": w["corps"], "score": w.get("score")}
                filled += 1
        if filled:
            log(f"champions: filled {filled} seasons from public record")
    champs = {y: v for y, v in champs.items() if v}
    return {str(y): v for y, v in sorted(champs.items())}


def build_corps(events):
    perfs = defaultdict(list)
    for ev in events:
        for c in ev["classes"]:
            for r in c["results"]:
                perfs[r["corps"]].append({
                    "y": ev["year"], "d": ev.get("date"), "ev": ev.get("name"),
                    "cls": c["class"], "p": r.get("place"), "s": r.get("score"),
                })
    index = []
    for corps, plist in sorted(perfs.items()):
        plist.sort(key=lambda x: (x["y"], x["d"] or ""))
        years = sorted({p["y"] for p in plist})
        scored = [p["s"] for p in plist if p["s"]]
        slug = slugify(corps)
        write_json(f"corps/{slug}.json", {"name": corps, "performances": plist})
        season_best = defaultdict(float)
        season_class = {}
        for p in plist:
            if (p["s"] or 0) > season_best[p["y"]]:
                season_best[p["y"]] = p["s"]
                season_class[p["y"]] = p["cls"]
        index.append({
            "name": corps, "slug": slug,
            "first": years[0], "last": years[-1], "seasons": len(years),
            "best": max(scored) if scored else None, "n": len(plist),
            "series": [[y, season_best[y] or None, season_class.get(y)] for y in years],
        })
    write_json("corps_index.json", index)

    by_decade = defaultdict(list)
    for corps, plist in perfs.items():
        for p in plist:
            by_decade[(p["y"] // 10) * 10].append(
                [p["y"], p.get("d"), p.get("ev"), corps, p.get("cls"), p.get("p"), p.get("s")])
    decades = []
    for dec, rows in sorted(by_decade.items()):
        rows.sort(key=lambda r: (r[0], r[1] or "", r[2] or "", r[5] if r[5] is not None else 99))
        write_json(f"db/perfs_{dec}s.json", rows)
        decades.append({"decade": f"{dec}s", "rows": len(rows)})
    write_json("db/index.json", decades)
    return index


def build_rankings(events):
    now = datetime.now(timezone.utc)
    season = max((e["year"] for e in events), default=now.year)
    dated = sorted([e for e in events if e.get("date") and e["year"] == season],
                   key=lambda e: e["date"])
    per_class = defaultdict(dict)
    for ev in dated:
        for c in ev["classes"]:
            for r in c["results"]:
                if not r.get("score"):
                    continue
                per_class[c["class"]].setdefault(r["corps"], []).append(
                    {"date": ev["date"], "score": r["score"], "event": ev["name"]})
    standings = {}
    for cls, corps_map in per_class.items():
        rows = []
        for corps, hist in corps_map.items():
            hist.sort(key=lambda h: h["date"])
            latest, prev = hist[-1], (hist[-2] if len(hist) > 1 else None)
            hi = max(hist, key=lambda h: h["score"])
            rows.append({
                "corps": corps, "score": latest["score"], "date": latest["date"],
                "event": latest["event"],
                "high": hi["score"], "high_event": hi["event"], "high_date": hi["date"],
                "prev_score": prev["score"] if prev else None,
                "delta": round(latest["score"] - prev["score"], 3) if prev else None,
                "outings": len(hist),
                "trend": [[h["date"], h["score"]] for h in hist][-10:],
            })
        rows.sort(key=lambda r: -(r["score"] or 0))
        for i, r in enumerate(rows):
            r["rank"] = i + 1
        movers = sorted([r for r in rows if r["delta"] is not None],
                        key=lambda r: -abs(r["delta"]))[:3]
        battles = []
        for a, b in zip(rows, rows[1:]):
            battles.append({"a": a["corps"], "b": b["corps"], "ra": a["rank"], "rb": b["rank"],
                            "sa": a["score"], "sb": b["score"],
                            "gap": round(a["score"] - b["score"], 3)})
        battles.sort(key=lambda x: x["gap"])
        standings[cls] = {"rows": rows, "movers": movers, "battles": battles[:3]}

    recent = []
    for ev in dated[-10:][::-1]:
        winner = None
        for c in ev["classes"]:
            res = [r for r in c["results"] if r.get("score")]
            res.sort(key=lambda r: -(r["score"] or 0))
            if res and (winner is None or (res[0]["score"] or 0) > (winner["score"] or 0)):
                winner = {"corps": res[0]["corps"], "score": res[0]["score"], "class": c["class"]}
        recent.append({"name": ev["name"], "date": ev.get("date"),
                       "location": ev.get("location"), "winner": winner})

    return {
        "generated": now.strftime("%Y-%m-%d %H:%M UTC"),
        "season": season,
        "standings": standings,
        "recent_events": recent,
    }


# ---------------------------------------------------------------- captions
# DCI's judging sheet (2013–present): GE1 + GE2 (Rep/Perf), Visual
# (Proficiency / Analysis / Color Guard, each Cont|Comp/Achv), Music (Brass /
# Analysis / Percussion, each Cont/Achv), penalties, total. A recap row's
# atomic numeric cells therefore appear in a fixed order (30 values), and the
# sheet's own arithmetic (caption sums → subtotals → total) lets us verify
# every parse — rows that don't reconcile are dropped, never guessed.
ATOM = re.compile(r"^\d{1,3}\.\d{1,3}(?:\s+\d{1,2})?$")
DASH = re.compile(r"^(--|-|—|0)$")

CAPTION_COLS = ["ge1", "ge2", "ge", "vp", "va", "cg", "vis",
                "br", "ma", "pc", "mus", "pen", "tot"]


EPS = 0.015


def _t(a, i):
    """judge triplet at index i: (score, score, total) with total verified"""
    x, y, t = a[i], a[i + 1], a[i + 2]
    return t if abs(x + y - t) < EPS else None


def _triples(a, i, n):
    """n judge triplets starting at index i — their totals, or None."""
    ts = []
    for k in range(n):
        t = _t(a, i + 3 * k)
        if t is None:
            return None
        ts.append(t)
    return ts


def _ge_readings(ts, tot):
    """Possible (ge1, ge2) for a GE block. 2 triplets = single panel;
    3 or 4 = one/both judges doubled (adjacent pairs averaged)."""
    if len(ts) == 2:
        cands = [(ts[0], ts[1])]
    elif len(ts) == 3:
        cands = [((ts[0] + ts[1]) / 2, ts[2]), (ts[0], (ts[1] + ts[2]) / 2)]
    elif len(ts) == 4:
        cands = [((ts[0] + ts[1]) / 2, (ts[2] + ts[3]) / 2)]
    else:
        return []
    ok = [(round(g1, 3), round(g2, 3), abs(g1 + g2 - tot)) for g1, g2 in cands
          if abs(g1 + g2 - tot) < EPS]
    exact = [c[:2] for c in ok if c[2] < 5e-4]
    return exact if exact else [c[:2] for c in ok]


def _capt_readings(ts, tot):
    """Possible (c1, c2, c3) for a visual/music block (tot = sum/2).
    3 triplets = single panel; 4 = one caption double-judged."""
    if len(ts) == 3:
        cands = [tuple(ts)]
    elif len(ts) == 4:
        cands = [((ts[0] + ts[1]) / 2, ts[2], ts[3]),
                 (ts[0], (ts[1] + ts[2]) / 2, ts[3]),
                 (ts[0], ts[1], (ts[2] + ts[3]) / 2)]
    else:
        return []
    ok = [(tuple(round(x, 3) for x in c), abs(sum(c) / 2 - tot)) for c in cands
          if abs(sum(c) / 2 - tot) < EPS]
    exact = [c for c, d in ok if d < 5e-4]
    return exact if exact else [c for c, d in ok]


def _parse_full_panel(a):
    """General full-sheet decomposition: GE block (2-4 triplets), visual
    block (3-4), music block (3-4), then sub/pen/tot. Every candidate must
    reconcile arithmetically; rows with multiple distinct readings are
    rejected rather than guessed."""
    n = len(a)
    results = []
    for ge_n in (2, 3, 4):
        for vis_n in (3, 4):
            for mus_n in (3, 4):
                if (ge_n + vis_n + mus_n) * 3 + 6 != n:
                    continue
                i = 0
                ge_ts = _triples(a, i, ge_n)
                if ge_ts is None:
                    continue
                ge_tot = a[i + 3 * ge_n]
                i += 3 * ge_n + 1
                vis_ts = _triples(a, i, vis_n)
                if vis_ts is None:
                    continue
                vis_tot = a[i + 3 * vis_n]
                i += 3 * vis_n + 1
                mus_ts = _triples(a, i, mus_n)
                if mus_ts is None:
                    continue
                mus_tot = a[i + 3 * mus_n]
                i += 3 * mus_n + 1
                sub = a[i]
                pen, tot = a[i + 1], a[i + 2]
                if abs(ge_tot + vis_tot + mus_tot - sub) > EPS:
                    continue
                for ge1, ge2 in _ge_readings(ge_ts, ge_tot):
                    for vp, va, cg in _capt_readings(vis_ts, vis_tot):
                        for br, ma, pc in _capt_readings(mus_ts, mus_tot):
                            results.append((
                                [ge1, ge2, round(ge_tot, 3), vp, va, cg,
                                 round(vis_tot, 3), br, ma, pc,
                                 round(mus_tot, 3), pen, tot], sub))
    if not results:
        return None
    subs = {round(r[1], 3) for r in results}
    if len(subs) != 1:
        return None  # layouts disagree on the subtotal — reject outright
    # element-wise consensus: agreed values publish; a caption the sheet's
    # arithmetic can't pin down goes null instead of sinking the whole row
    consensus = []
    for pos in range(13):
        vs = {r[0][pos] for r in results}
        consensus.append(vs.pop() if len(vs) == 1 else None)
    # totals must never be ambiguous
    if any(consensus[i] is None for i in (2, 6, 10, 11, 12)):
        return None
    return consensus, results[0][1]


def _layout_19(a):  # reduced panel: judge assignments vary and sub-caption
    # scales differ from full panels, so only GE (structurally identical
    # two-judge panel) and the reconciled totals are published.
    ge1, ge2 = _t(a, 0), _t(a, 3)
    ge, sub, pen, tot = a[6], a[16], a[17], a[18]
    if None in (ge1, ge2) or abs(ge1 + ge2 - ge) > EPS:
        return None
    m1v, m2v = _t(a, 9), _t(a, 12)
    vis_first = (abs(a[7] - a[8]) < EPS and m1v is not None and m2v is not None
                 and abs(m1v + m2v - a[15]) < EPS
                 and abs(ge + a[7] + a[15] - sub) < EPS)
    m1m, m2m = _t(a, 7), _t(a, 10)
    mus_first = (m1m is not None and m2m is not None
                 and abs(m1m + m2m - a[13]) < EPS and abs(a[14] - a[15]) < EPS
                 and abs(ge + a[14] + a[13] - sub) < EPS)
    if not (vis_first or mus_first):
        return None
    return [ge1, ge2, ge, None, None, None, None, None, None, None, None, pen, tot], sub



def parse_recap_cells(cells) -> dict | None:
    atoms = []
    for c in cells:
        t = norm_space(str(c))
        if ATOM.fullmatch(t):
            atoms.append(float(t.split()[0]))
        elif DASH.fullmatch(t):
            atoms.append(0.0)
    try:
        if len(atoms) == 19:
            parsed = _layout_19(atoms)
        elif len(atoms) >= 27:
            parsed = _parse_full_panel(atoms)
        else:
            parsed = None
    except IndexError:
        return None
    if not parsed:
        return None
    vals, sub = parsed
    pen, tot = vals[11], vals[12]
    if abs(sub - pen - tot) > EPS:
        # recaps often print '--' where a penalty was assessed; the penalty is
        # still recoverable from the sheet's own arithmetic
        recovered = round(sub - tot, 3)
        if pen == 0.0 and 0 < recovered <= 10:
            vals[11] = recovered
        else:
            return None
    return dict(zip(CAPTION_COLS, [round(v, 3) if v is not None else None for v in vals]))


def build_captions(events):
    by_year = defaultdict(list)
    parsed = dropped = 0
    for ev in events:
        for rc in ev.get("recap") or []:
            cls = canon_class(rc.get("class"))
            if cls == "Exhibition" or IE_CLASS.search(norm_space(rc.get("class") or "")):
                continue
            for row in rc.get("rows") or []:
                corps = canon_corps(row.get("corps") or "")
                if not corps:
                    continue
                caps = parse_recap_cells(row.get("cells") or [])
                if not caps:
                    dropped += 1
                    continue
                parsed += 1
                by_year[ev["year"]].append(
                    [ev.get("date"), ev.get("name"), cls, corps,
                     *[caps[k] for k in CAPTION_COLS]])
    # caption titles: the best score in each judged caption at the season's
    # championship recap. Finals preferred; when a finals recap never
    # published (2013/2016/2019 have gaps) the semifinals or prelims stand
    # in, and the entry says which round decided it.
    def _title_tier(name):
        n = (name or "").lower()
        if "world championship" not in n and "dci championship" not in n:
            return 0                          # regionals don't decide titles
        if "semi" in n:
            return 2
        if "prelim" in n:
            return 1
        return 3                              # finals (or single-day championship)
    title_keys = CAPTION_COLS[:-2]          # every judged caption; no pen/tot
    # participants per (year, event, class) from the scoreboard, to catch
    # recaps that dropped finalists during verification
    participants = defaultdict(set)
    for ev in events:
        for c in ev.get("classes") or []:
            for r in c.get("results") or []:
                if r.get("score"):
                    participants[(ev["year"], ev.get("name"), c["class"])].add(r["corps"])
    titles_out = defaultdict(list)
    for year, rows in by_year.items():
        pick = {}                            # cls -> best (tier, date, event)
        for r in rows:
            t = _title_tier(r[1])
            if t:
                cand = (t, r[0] or "", r[1])
                if r[2] not in pick or cand > pick[r[2]]:
                    pick[r[2]] = cand
        for cls, (tier, d, evname) in pick.items():
            best = {}
            nulls = defaultdict(int)   # corps whose value for a caption is unverifiable
            for r in rows:
                if r[2] != cls or r[1] != evname or (r[0] or "") != d:
                    continue
                for i, k in enumerate(title_keys):
                    v = r[4 + i]
                    if v is None:
                        nulls[k] += 1
                        continue
                    if k not in best or v > best[k][1]:
                        best[k] = ([r[3]], v)
                    elif v == best[k][1] and r[3] not in best[k][0]:
                        best[k][0].append(r[3])
            if best:
                have = {r[3] for r in rows if r[2] == cls and r[1] == evname and (r[0] or "") == d}
                missing = participants.get((year, evname, cls), set()) - have
                # a winner is only certain when every competitor's value for
                # that caption verified; otherwise it carries an asterisk
                entry = {
                    "y": year, "d": d or None, "event": evname,
                    "round": {3: "finals", 2: "semifinals", 1: "prelims"}[tier],
                    "w": {k: [" & ".join(ns), v] + ([1] if (nulls.get(k) or missing) else [])
                          for k, (ns, v) in best.items()},
                }
                if missing:
                    entry["partial"] = sorted(missing)
                titles_out[cls].append(entry)
    for cls in titles_out:
        titles_out[cls].sort(key=lambda e: e["y"])
    write_json("caption_titles.json", dict(titles_out))
    log(f"caption titles: {sum(len(v) for v in titles_out.values())} class-seasons")

    index = []
    for year, rows in sorted(by_year.items()):
        rows.sort(key=lambda r: (r[0] or "", r[1] or ""))
        write_json(f"captions/{year}.json", rows)
        index.append({"year": year, "rows": len(rows)})
    write_json("captions/index.json",
               {"seasons": index, "cols": ["date", "event", "class", "corps", *CAPTION_COLS]})
    log(f"captions: {parsed} rows verified, {dropped} rows failed reconciliation (dropped)")
    return index


# ------------------------------------------------------------ judge recaps
# The official recap sheet, kept at full fidelity: every judge's sub-scores
# (Rep/Perf, Cont/Achv, …) plus the sheet's own per-caption ranks. Unlike the
# reconciled captions dataset above, nothing here is derived — the header
# hierarchy and every value/rank pair are read straight off the published
# sheet, and a row is only kept when its cell count matches the header
# structure exactly.
ATOM_R = re.compile(r"^(\d{1,3}\.\d{1,3})(?:\s+(\d{1,2}))?$")


def _recap_sub(caps, i, n):
    """One sub-caption: [megastring, name, judge?, col..., 'TOT']. The
    megastring is the concatenation of its parts, which lets us verify the
    split (and detect sheets that omit the judge cell)."""
    if i + 2 >= n:
        return None
    mega, name = norm_space(caps[i]), norm_space(caps[i + 1])
    j = i + 2
    parts = []
    while j < n and norm_space(caps[j]).upper() != "TOT":
        parts.append(norm_space(caps[j]))
        j += 1
        if len(parts) > 4:
            return None
    if j >= n or not parts:
        return None
    for judge, colnames in ((parts[0], parts[1:]), ("", parts)):
        if not colnames:
            continue
        if norm_space(mega) == norm_space(f"{name} {judge} {''.join(colnames)} TOT"):
            return {"n": name, "j": judge, "cols": colnames}, j + 1
    return None


def _recap_header(caps):
    """Header tree: [{n, subs:[{n, j, cols}]}] — a group may have no subs
    when only its total was published (e.g. combined visual panels)."""
    if not caps or norm_space(caps[0]).lower() != "corps":
        return None
    i, n = 1, len(caps)
    groups = []
    while i < n:
        c = norm_space(caps[i])
        if c.lower() in ("sub total", "subtotal", "sub-total"):
            break
        if i + 1 >= n:
            return None
        g = {"n": norm_space(caps[i + 1]), "subs": []}
        i += 2
        closed = False
        while i < n:
            if norm_space(caps[i]).upper() == "TOT":
                i += 1
                closed = True
                break
            sub = _recap_sub(caps, i, n)
            if not sub:
                return None
            g["subs"].append(sub[0])
            i = sub[1]
        if not closed:
            return None
        groups.append(g)
    return groups or None


def _recap_atoms(cells):
    """Leaf (value, rank) cells in sheet order; megastrings never match."""
    out = []
    for c in cells:
        t = norm_space(str(c))
        m = ATOM_R.fullmatch(t)
        if m:
            out.append((float(m.group(1)), int(m.group(2)) if m.group(2) else None))
        elif DASH.fullmatch(t):
            out.append((0.0, None))
    return out


def build_recaps(events):
    by_year = defaultdict(list)
    kept = skipped = 0
    for ev in events:
        classes = {}
        for rc in ev.get("recap") or []:
            cls = canon_class(rc.get("class"))
            if cls == "Exhibition" or IE_CLASS.search(norm_space(rc.get("class") or "")):
                continue
            groups = rc.get("groups") or _recap_header(rc.get("captions") or [])
            if not groups:
                skipped += len(rc.get("rows") or [])
                continue
            need = sum(sum(len(s["cols"]) + 1 for s in g["subs"]) + 1 for g in groups) + 3
            rows = []
            for row in rc.get("rows") or []:
                corps = canon_corps(row.get("corps") or "")
                atoms = _recap_atoms(row.get("cells") or [])
                if not corps or len(atoms) != need:
                    skipped += 1
                    continue
                rows.append([corps, [a[0] for a in atoms], [a[1] for a in atoms]])
            if not rows:
                continue
            kept += len(rows)
            # duplicate class blocks: keep the fuller sheet
            if cls not in classes or len(rows) > len(classes[cls]["rows"]):
                classes[cls] = {"c": cls, "groups": groups, "rows": rows}
        if classes:
            by_year[ev["year"]].append(
                {"d": ev.get("date"), "e": ev.get("name"), "classes": list(classes.values())})
    for year, evs in sorted(by_year.items()):
        evs.sort(key=lambda e: (e["d"] or "", e["e"] or ""))
        write_json(f"recaps/{year}.json", {"events": evs})
    write_json("recaps/index.json",
               {"seasons": [{"year": y, "events": len(v)} for y, v in sorted(by_year.items())]})
    log(f"judge recaps: {kept} rows across {sum(len(v) for v in by_year.values())} events, {skipped} rows unparseable")


def build_records(events):
    """docs/data/records.json — compact inputs for the all-time record book.
    The client derives every list (titles, streaks, margins, appearances)
    from these, so era/class/corps filters stay instant:
      top:    each season's 10 highest single-show scores per class
      finals: championship-finals results per class/year (top 15 by score)
    """
    main_classes = ("World Class", "Open Class", "All-Age")
    per_year = defaultdict(lambda: defaultdict(list))   # cls -> year -> rows
    finals = defaultdict(dict)                          # cls -> year -> rows
    for ev in events:
        finals_ev = is_champ_finals(ev)
        n = (ev.get("name") or "").lower()
        for c in ev.get("classes") or []:
            cls = c["class"]
            res = [r for r in (c.get("results") or []) if r.get("score")]
            if not res:
                continue
            if cls in main_classes:
                for r in res:
                    per_year[cls][ev["year"]].append(
                        [ev["year"], ev.get("date"), r["corps"], r["score"], ev.get("name")])
            if finals_ev:
                fcls = cls
                if "open class" in n and cls == "World Class":
                    fcls = "Open Class"
                if "all-age" in n or "all age" in n:
                    fcls = "All-Age"
                if fcls not in main_classes:
                    continue
                rows = sorted(res, key=lambda r: -(r["score"] or 0))
                rows = [[r["corps"], r["score"]] for r in rows][:15]
                cur = finals[fcls].get(ev["year"])
                if cur is None or rows[0][1] > cur[0][1]:
                    finals[fcls][ev["year"]] = rows
    # seasons whose championship finals never scraped still have a documented
    # champion (public record) — give the record book a one-row finals entry
    # so titles and dynasties count those years
    wp = PARSED / "wiki_champions.json"
    if wp.exists():
        for year, w in json.loads(wp.read_text()).items():
            y = int(year)
            if w.get("corps") and y not in finals["World Class"]:
                finals["World Class"][y] = [[canon_corps(w["corps"]), w.get("score")]]

    out = {}
    for cls in main_classes:
        top = []
        for year, entries in per_year[cls].items():
            # duplicate archive listings of the same show: keep the dated copy
            entries.sort(key=lambda e: (-(e[3] or 0), e[1] is None))
            seen = set()
            deduped = []
            for e in entries:
                k = (e[2], round(e[3] or 0, 3))
                if k in seen:
                    continue
                seen.add(k)
                deduped.append(e)
            top.extend(deduped[:10])
        top.sort(key=lambda e: (-(e[3] or 0), e[0]))
        f = {str(y): v for y, v in sorted(finals[cls].items())}
        if top or f:
            out[cls] = {"top": top, "finals": f}
    write_json("records.json", out)
    log(f"records: {sum(len(v['top']) for v in out.values())} top rows, "
        f"{sum(len(v['finals']) for v in out.values())} finals seasons")


def build_pace(events, champions):
    """docs/data/pace.json — every champion's score-by-date curve, so the
    current leaders can be charted against title pace. Seasons need at
    least 4 scored shows for the champion or the curve is too thin to use."""
    by_year = defaultdict(list)
    for ev in events:
        if ev.get("date"):
            by_year[ev["year"]].append(ev)
    curves = defaultdict(list)
    for y_str, by_cls in champions.items():
        y = int(y_str)
        for cls, w in by_cls.items():
            name = w.get("corps")
            if not name:
                continue
            pts = {}
            for ev in by_year.get(y, []):
                for c in ev.get("classes") or []:
                    if c["class"] != cls:
                        continue
                    for r in c.get("results") or []:
                        if r.get("corps") == name and r.get("score"):
                            d = ev["date"]
                            pts[d] = max(r["score"], pts.get(d, 0))
            pts = sorted(pts.items())
            if len(pts) >= 4:
                curves[cls].append({
                    "y": y, "corps": name,
                    "final": w.get("score") or pts[-1][1],
                    "pts": [[d, s] for d, s in pts],
                })
    for cls in curves:
        curves[cls].sort(key=lambda e: -e["y"])
    write_json("pace.json", dict(curves))
    log(f"pace: {sum(len(v) for v in curves.values())} champion curves")


NON_PERF_UI = re.compile(
    r"gates open|welcome|anthem|intermission|scores? announced|encore|award|"
    r"ceremon|recognition|pledge|meeting|clinic|autograph", re.I)


def build_upcoming():
    """docs/data/upcoming.json from data/parsed/dci_upcoming.json (events
    calendar scrape): future events with lineups for the homepage."""
    p = PARSED / "dci_upcoming.json"
    rows = []
    if p.exists():
        # "today" in DCI's world is US time: an event stays upcoming until
        # ~6 AM Eastern the next day, so tonight's shows never vanish at
        # midnight UTC (8 PM ET) while corps are still on the field
        from datetime import timedelta
        today = (datetime.now(timezone.utc) - timedelta(hours=10)).strftime("%Y-%m-%d")
        for ev in json.loads(p.read_text()):
            if ev.get("date") and ev["date"] >= today:
                row = {
                    "name": ev.get("name"), "date": ev["date"],
                    "date_display": ev.get("date_display"),
                    "location": ev.get("location"), "url": ev.get("url"),
                    "lineup": [canon_corps(c) for c in (ev.get("lineup") or [])],
                }
                if ev.get("schedule"):
                    row["schedule"] = [[t, canon_corps(e) if not NON_PERF_UI.search(e) else e]
                                       for t, e in ev["schedule"]]
                if ev.get("bag_policy"):
                    row["bag_policy"] = ev["bag_policy"]
                rows.append(row)
        rows.sort(key=lambda e: (e["date"], e.get("name") or ""))
    write_json("upcoming.json", rows[:60])


def build_news():
    """docs/data/news.json from data/parsed/dci_news.json (official DCI RSS,
    fetched by scripts/fetch_dci_news.py): headline cards plus the
    auditions/camps tags the Shows page surfaces."""
    p = PARSED / "dci_news.json"
    if p.exists():
        write_json("news.json", json.loads(p.read_text()))


def main():
    # wipe output dir so removed features never leave stale files behind
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    events = load_events()
    season_index = build_seasons(events)
    champions = build_champions(events)
    corps_index = build_corps(events)
    rankings = build_rankings(events)
    build_captions(events)
    build_recaps(events)
    build_records(events)
    build_upcoming()
    build_news()

    # corps profiles (Wikipedia lead + infobox), when the scraper has run
    prof_p = PARSED / "corps_profiles.json"
    if prof_p.exists():
        profs = {k: v for k, v in json.loads(prof_p.read_text()).items() if v}
        write_json("profiles.json", profs)
        log(f"profiles: {len(profs)} corps")

    write_json("champions.json", champions)
    write_json("rankings.json", rankings)
    write_json("meta.json", {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "seasons": season_index,
        "counts": {"events": len(events), "corps": len(corps_index)},
        "source": {"name": "DCI.org — official scores (Competition Suite)",
                   "url": "https://www.dci.org/scores"},
    })
    log("build complete")


if __name__ == "__main__":
    main()
