#!/usr/bin/env python3
"""Precompute per-app insights.json for the Cadence scoreboard family.

Reads every seasons/<year>.json (and captions/ where present) for each app
and writes docs/<app>/data/insights.json following the contract in
docs/family/BOARD-CONTRACT.md.  Honest math only:

- score circuits  -> recent_events / season_leaders / trajectory / yoy /
                     class_dist (+ captions where caption rows exist)
- UIL (ratings)   -> ratings distributions + per-band rating history
                     (1 = Superior, lower is better: never averaged) and
                     state-finals placement history
- ISSMA           -> placement history only (scores are directors-only)

Every key in the output is optional; empty sections are omitted.  The script
only ever writes <app>/data/insights.json — nothing else is touched.
Safe to re-run (idempotent).
"""

import json
import os
import sys
from datetime import datetime, timezone

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
DOCS = os.path.normpath(DOCS)

# (app label, data dir relative to docs/, board shape as declared by APP_CFG)
APPS = [
    ("dci",            "data",                "trend"),
    ("boa",            "boa/data",            "event"),
    ("usbands",        "usbands/data",        "trend"),
    ("uil",            "uil/data",            "rating"),
    ("wgasc",          "wgasc/data",          "trend"),
    ("tcgc",           "tcgc/data",           "trend"),
    ("ffcc",           "ffcc/data",           "trend"),
    ("wgi/guard",      "wgi/guard/data",      "trend"),
    ("wgi/percussion", "wgi/percussion/data", "trend"),
    ("wgi/winds",      "wgi/winds/data",      "trend"),
]

# list caps that keep files small without losing anything a board would show
RECENT_EVENTS = 8       # newest events on an event board
TOP_PER_CLASS = 5       # top rows per class inside a recent event
LEADERS_PER_CLASS = 50  # season leaders per class
YOY_MOVERS = 40         # biggest risers/fallers
TRAJ_MIN_SEASONS = 3    # a trajectory needs 3+ scored seasons to be a line
YOY_MAX_GAP = 2         # "year over year" tolerates one skipped season (COVID)


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def season_files(data_dir):
    sdir = os.path.join(data_dir, "seasons")
    if not os.path.isdir(sdir):
        return []
    out = []
    for name in sorted(os.listdir(sdir)):
        if name.endswith(".json") and name[:-5].isdigit():
            out.append((int(name[:-5]), os.path.join(sdir, name)))
    return out


def rnd(x, n=3):
    v = round(float(x), n)
    return int(v) if v == int(v) else v


def percentile(sorted_vals, p):
    """Linear-interpolated percentile over an already-sorted list."""
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    frac = k - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def dist(values):
    vals = sorted(values)
    return {
        "min": rnd(vals[0]),
        "p25": rnd(percentile(vals, 0.25), 2),
        "median": rnd(percentile(vals, 0.50), 2),
        "p75": rnd(percentile(vals, 0.75), 2),
        "max": rnd(vals[-1]),
        "n": len(vals),
    }


def scan_seasons(data_dir):
    """Yield (year, event, cls, result) for every result row on disk.

    Events marked source == "demo" are placeholder/fabricated data (all of
    WGI's scored rows, BOA's 2026 file) — never fold them into insights.
    """
    for year, path in season_files(data_dir):
        for event in load_json(path):
            if event.get("source") == "demo":
                continue
            for cls in event.get("classes") or []:
                for res in cls.get("results") or []:
                    yield year, event, cls, res


# ---------------------------------------------------------------- score apps

def build_score_insights(data_dir):
    rows = 0
    # per-year, per-class, per-corps best score (drives leaders/traj/yoy/dist)
    best = {}          # year -> class -> corps -> (score, event, date, count)
    events_latest = {} # id(event) -> (year, event dict) for scored events
    corps_years = {}   # corps -> year -> best score (any class)

    for year, event, cls, res in scan_seasons(data_dir):
        rows += 1
        score = res.get("score")
        if not isinstance(score, (int, float)):
            continue
        cname = cls.get("class") or "Unclassified"
        corps = res.get("corps")
        if not corps:
            continue
        ycls = best.setdefault(year, {}).setdefault(cname, {})
        cur = ycls.get(corps)
        if cur is None:
            ycls[corps] = [score, event.get("name"), event.get("date"), 1]
        else:
            cur[3] += 1
            if score > cur[0]:
                cur[0], cur[1], cur[2] = score, event.get("name"), event.get("date")
        yb = corps_years.setdefault(corps, {})
        if year not in yb or score > yb[year]:
            yb[year] = score
        events_latest.setdefault(id(event), (year, event))

    if not best:
        return None, rows

    seasons = sorted(best)
    latest = seasons[-1]
    out = {"latest_year": latest, "seasons": seasons}

    # ---- recent_events: newest scored events, top rows per class
    scored_events = []
    for year, event in events_latest.values():
        classes = []
        merged = {}  # class blocks can repeat (e.g. DCI All-Age splits)
        for cls in event.get("classes") or []:
            cname = cls.get("class") or "Unclassified"
            for res in cls.get("results") or []:
                if isinstance(res.get("score"), (int, float)):
                    merged.setdefault(cname, []).append(res)
        for cname, results in merged.items():
            results.sort(key=lambda r: -r["score"])
            classes.append({
                "class": cname,
                "n": len(results),
                "median": rnd(percentile(sorted(r["score"] for r in results), 0.5), 2),
                "top": [{"corps": r.get("corps"), "score": rnd(r["score"]),
                         "rank": i + 1}
                        for i, r in enumerate(results[:TOP_PER_CLASS])],
            })
        if classes:
            scored_events.append((event.get("date") or "", year, event, classes))
    scored_events.sort(key=lambda t: (t[0], t[1]), reverse=True)
    out["recent_events"] = [{
        "name": ev.get("name"),
        "date": ev.get("date"),
        "location": ev.get("location"),
        "classes": cls,
    } for _, _, ev, cls in scored_events[:RECENT_EVENTS]]

    # ---- season_leaders: best score per ensemble this season, per class
    leaders = {}
    for cname, corps_map in best[latest].items():
        rows_ = [{"corps": corps, "best": rnd(v[0]), "best_event": v[1],
                  "best_date": v[2], "events": v[3]}
                 for corps, v in corps_map.items()]
        rows_.sort(key=lambda r: -r["best"])
        leaders[cname] = rows_[:LEADERS_PER_CLASS]
    out["season_leaders"] = leaders

    # ---- trajectory: [year, best] for ensembles with 3+ scored seasons
    trajectory = {}
    for corps, yb in corps_years.items():
        if len(yb) >= TRAJ_MIN_SEASONS:
            trajectory[corps] = [[y, rnd(s)] for y, s in sorted(yb.items())]
    if trajectory:
        out["trajectory"] = trajectory

    # ---- yoy: biggest movement into the latest season (gap <= YOY_MAX_GAP)
    latest_class = {}
    for cname, corps_map in best[latest].items():
        for corps, v in corps_map.items():
            cur = latest_class.get(corps)
            if cur is None or v[0] > cur[1]:
                latest_class[corps] = (cname, v[0])
    movers = []
    for corps, (cname, to_score) in latest_class.items():
        prev_years = [y for y in corps_years[corps] if y < latest]
        if not prev_years:
            continue
        prev = max(prev_years)
        if latest - prev > YOY_MAX_GAP:
            continue
        from_score = corps_years[corps][prev]
        movers.append({"corps": corps, "class": cname,
                       "from": rnd(from_score), "to": rnd(to_score),
                       "delta": rnd(to_score - from_score, 2),
                       "years": [prev, latest]})
    movers.sort(key=lambda m: -abs(m["delta"]))
    if movers:
        out["yoy"] = movers[:YOY_MOVERS]

    # ---- class_dist: score spread per class per season
    class_dist = {}
    per_class_year = {}  # class -> year -> [all scored performances]
    for year, event, cls, res in scan_seasons(data_dir):
        score = res.get("score")
        if isinstance(score, (int, float)):
            cname = cls.get("class") or "Unclassified"
            per_class_year.setdefault(cname, {}).setdefault(year, []).append(score)
    for cname, years in per_class_year.items():
        class_dist[cname] = {str(y): dist(v) for y, v in sorted(years.items())}
    out["class_dist"] = class_dist

    # ---- captions: per-class per-season caption averages from real rows
    captions = build_captions(data_dir)
    if captions:
        out["captions"] = captions

    return out, rows


def build_captions(data_dir):
    cdir = os.path.join(data_dir, "captions")
    idx_path = os.path.join(cdir, "index.json")
    if not os.path.isfile(idx_path):
        return None
    idx = load_json(idx_path)
    cols = idx.get("cols") or []
    if "corps" not in cols:
        return None
    first = cols.index("corps") + 1
    # caption columns are everything after 'corps' except penalty and total
    cap_cols = [(i, c) for i, c in enumerate(cols[first:], start=first)
                if c not in ("pen", "tot")]
    try:
        class_i = cols.index("class")
    except ValueError:
        return None

    agg = {}  # class -> year -> col -> [sum, n]
    for season in idx.get("seasons") or []:
        year = season.get("year")
        path = os.path.join(cdir, f"{year}.json")
        if not os.path.isfile(path):
            continue
        for row in load_json(path):
            cname = row[class_i] or "Unclassified"
            slot = agg.setdefault(cname, {}).setdefault(year, {})
            for i, c in cap_cols:
                v = row[i] if i < len(row) else None
                # 0.0 in a caption column means "not judged", never a score
                if isinstance(v, (int, float)) and v > 0:
                    s = slot.setdefault(c, [0.0, 0])
                    s[0] += v
                    s[1] += 1
    out = {}
    for cname, years in agg.items():
        ymap = {}
        for year, colsums in sorted(years.items()):
            avg = {c: rnd(s / n, 2) for c, (s, n) in colsums.items() if n}
            if avg:
                ymap[str(year)] = avg
        if ymap:
            out[cname] = ymap
    return out or None


# ------------------------------------------------------------------ ratings

def build_rating_insights(data_dir):
    """UIL: division-rating distributions (1=Superior, lower is better —
    distributions and per-band history, never averages) plus state-finals
    placement history."""
    rows = 0
    ratings = {}        # class -> year -> {rating: count}
    band_ratings = {}   # band -> year -> best (lowest) rating
    placements = {}     # band -> year -> best (lowest) placement
    years_seen = set()

    for year, event, cls, res in scan_seasons(data_dir):
        rows += 1
        band = res.get("corps")
        if not band:
            continue
        rating = res.get("rating")
        if isinstance(rating, int):
            years_seen.add(year)
            cname = cls.get("class") or "Unclassified"
            slot = ratings.setdefault(cname, {}).setdefault(str(year), {})
            key = str(rating)
            slot[key] = slot.get(key, 0) + 1
            yb = band_ratings.setdefault(band, {})
            if year not in yb or rating < yb[year]:
                yb[year] = rating
        placement = res.get("placement")
        if isinstance(placement, int):
            years_seen.add(year)
            yp = placements.setdefault(band, {})
            if year not in yp or placement < yp[year]:
                yp[year] = placement

    if not years_seen:
        return None, rows
    out = {
        "latest_year": max(years_seen),
        "seasons": sorted(years_seen),
        "ratings": ratings,
        "band_ratings": {b: [[y, r] for y, r in sorted(m.items())]
                         for b, m in sorted(band_ratings.items())},
    }
    if placements:
        out["placements"] = {b: [[y, p] for y, p in sorted(m.items())]
                             for b, m in sorted(placements.items())}
    if not ratings:
        del out["ratings"]
    if not out.get("band_ratings"):
        del out["band_ratings"]
    return out, rows


# --------------------------------------------------------------- placements

def build_placement_insights(data_dir):
    """ISSMA: published placements only (lower is better)."""
    rows = 0
    placements = {}
    years_seen = set()
    for year, event, cls, res in scan_seasons(data_dir):
        rows += 1
        band = res.get("corps")
        placement = res.get("placement")
        if res.get("place") is not None and placement is None:
            placement = res.get("place")
        if not band or not isinstance(placement, int):
            continue
        years_seen.add(year)
        yp = placements.setdefault(band, {})
        if year not in yp or placement < yp[year]:
            yp[year] = placement
    if not placements:
        return None, rows
    out = {
        "latest_year": max(years_seen),
        "seasons": sorted(years_seen),
        "placements": {b: [[y, p] for y, p in sorted(m.items())]
                       for b, m in sorted(placements.items())},
    }
    return out, rows


# --------------------------------------------------------------------- main

def main():
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    written = []
    for app, rel, shape in APPS:
        data_dir = os.path.join(DOCS, rel)
        if not os.path.isdir(os.path.join(data_dir, "seasons")):
            print(f"{app:15s} skipped (no seasons/)")
            continue
        if shape == "rating":
            insights, rows = build_rating_insights(data_dir)
        elif shape == "placement":
            insights, rows = build_placement_insights(data_dir)
        else:
            insights, rows = build_score_insights(data_dir)
        if not insights:
            stale = os.path.join(data_dir, "insights.json")
            if os.path.isfile(stale):
                os.remove(stale)  # our own output from an earlier run
            print(f"{app:15s} skipped (no scored data; {rows} rows scanned)")
            continue
        doc = {"shape": shape, "updated": updated}
        doc.update(insights)
        out_path = os.path.join(data_dir, "insights.json")
        blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(blob)
        size = len(blob.encode("utf-8"))
        n_seasons = len(doc.get("seasons") or [])
        print(f"{app:15s} rows={rows:6d} seasons={n_seasons:2d} "
              f"latest={doc.get('latest_year')} -> "
              f"{os.path.relpath(out_path, DOCS)} ({size / 1024:.1f} KB)")
        written.append((app, out_path, shape))

    # ---- verify: reload every file and assert the contract's schema keys
    failures = 0
    for app, path, shape in written:
        doc = load_json(path)
        try:
            assert doc["shape"] == shape
            assert "updated" in doc and "latest_year" in doc
            assert doc["seasons"] == sorted(doc["seasons"])
            if shape == "rating":
                assert "ratings" in doc and "band_ratings" in doc
                for hist in doc["band_ratings"].values():
                    assert all(1 <= r <= 5 for _, r in hist)
            elif shape == "placement":
                assert "placements" in doc
            else:
                assert "season_leaders" in doc and "class_dist" in doc
                for cls_rows in doc["season_leaders"].values():
                    scores = [r["best"] for r in cls_rows]
                    assert scores == sorted(scores, reverse=True)
        except AssertionError:
            failures += 1
            print(f"VERIFY FAILED for {app} ({path})")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
