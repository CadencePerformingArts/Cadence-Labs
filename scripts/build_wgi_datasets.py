#!/usr/bin/env python3
"""Derive the DCI-shaped datasets for the three WGI apps from their real
championship record.

WGI publishes live scores only through a directors-only portal, so Cadence has
no per-show score feed for it (there is no CompetitionSuite discovery on file
either — no data/wgi_probe.json). What IS openly published, and what these
apps already ship, is the championship record: every World Champion, class by
class, with the winning score. That record is real data, and it was sitting in
a single file (champions.json) that only one bespoke view could read, while
every other view in the app rendered an empty state.

This script fans that one file out into the shapes the shared engine already
knows how to render, so the WGI apps use the DCI views instead of a parallel
set of their own:

    champions.json  ──▶  corps_index.json        (Ensembles, Compare)
                    ──▶  corps/<slug>.json       (ensemble profiles)
                    ──▶  records.json            (Stats › Records)
                    ──▶  rankings.json           (Scoreboard)
                    ──▶  db/index.json + db/perfs_<decade>.json  (Database)

Every derived row is one championship title: year, class, champion, winning
score, place 1. Nothing is interpolated, averaged, projected or filled in.
Dates are the one thing the published record does not carry, so every derived
`date` is null and the views fall back to the year — a wrong-but-plausible
date would be exactly the kind of fabrication scripts/purge_fabricated.py
exists to clean up.

    python3 scripts/build_wgi_datasets.py            # write
    python3 scripts/build_wgi_datasets.py --check    # verify, write nothing
    python3 scripts/build_wgi_datasets.py --dry-run  # report, write nothing

Idempotent: a second run changes no byte of any file.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

APPS = ["wgi/guard", "wgi/percussion", "wgi/winds"]

# WGI's class hierarchy, most competitive first. Only the classes a given
# activity actually crowned champions in are used; anything the record holds
# that is not listed here sorts after these, alphabetically.
CLASS_ORDER = [
    "Independent World", "Independent Open", "Independent A",
    "Scholastic World", "Scholastic Open", "Scholastic A",
]

# The one event every derived row belongs to. WGI titles are decided at its
# World Championships; the class is what distinguishes the three activities'
# championship rounds, and the record does not publish a finer event name.
# No year in the name: every table that shows this column shows the season
# right beside it, and "2025 WGI World Championships" next to a Date cell
# reading 2025 just wrapped the column onto a third line.
EVENT = "WGI World Championships"


def event_name(year: int) -> str:
    return EVENT


def slug_of(name: str) -> str:
    """Mirrors slugOf() in docs/app.js — the router only matches [a-z0-9-]+."""
    import re
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", str(name).lower()))


def sort_classes(names):
    return sorted(names, key=lambda c: (CLASS_ORDER.index(c) if c in CLASS_ORDER else 99, c))


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


# ── the LIVE-marker contract ────────────────────────────────────────────────
# scripts/purge_fabricated.py owns the promise that these trees carry real
# data only: it writes docs/<app>/data/LIVE the moment it has stripped an app
# back to what is genuinely published, precisely so a generator can never
# refill it. This script writes into the same trees, so it answers to the same
# contract — and it must never be the thing that overwrites a richer, truly
# ingested dataset with a thinner derivation of it.
def refusal_reason(d: Path):
    """Why this tree must NOT be derived from champions.json, or None."""
    if not d.exists():
        return "no data directory"
    if not (d / "CHAMPS_LIVE").exists():
        return ("no CHAMPS_LIVE marker — the champion record here is not vouched "
                "for as real, and every derived row would inherit that")
    champs = load(d / "champions.json")
    if not isinstance(champs, dict) or not champs:
        return "champions.json is missing or empty"

    # A per-show score feed landing (the wgi-ingest workflow's `ingest` mode,
    # the day WGI grants portal access) makes this derivation obsolete rather
    # than wrong: the season files then hold every result, not just the
    # winners, and scripts/gen_family_data.py derives from those instead.
    seasons = d / "seasons"
    scored = 0
    for f in sorted(seasons.glob("*.json")) if seasons.exists() else []:
        for ev in load(f) or []:
            for c in (ev.get("classes") or []):
                scored += len(c.get("results") or [])
    if scored:
        return (f"{scored} scored result rows already published in seasons/ — a "
                "richer real ingest has landed; gen_family_data.py derives from it")

    live = (d / "LIVE").read_text().strip() if (d / "LIVE").exists() else ""
    if live and "real data only" not in live:
        return f"LIVE marker reads {live!r} — not the empty-state contract this script derives under"
    return None


# ── read the record ─────────────────────────────────────────────────────────
def read_titles(d: Path):
    """champions.json → a flat list of real title rows, newest last.

    Shape: {"<year>": {"<class>": {"corps": str, "score": num|null}}}
    """
    champs = load(d / "champions.json") or {}
    titles = []
    for year_s, by_cls in champs.items():
        if not str(year_s).lstrip("-").isdigit() or not isinstance(by_cls, dict):
            continue
        year = int(year_s)
        for cls, w in by_cls.items():
            if not isinstance(w, dict):
                continue
            corps = (w.get("corps") or "").strip()
            if not corps:
                continue
            score = w.get("score")
            titles.append({"year": year, "cls": cls, "corps": corps,
                           "score": None if score is None else float(score)})
    titles.sort(key=lambda t: (t["year"], sort_classes([t["cls"]])[0]))
    return titles


def title_key(t):
    return (t["year"], t["cls"], t["corps"], t["score"])


# ── the derived datasets ────────────────────────────────────────────────────
def build_corps(titles):
    """corps_index.json rows + corps/<slug>.json logs, from the titles alone."""
    by_corps = {}
    for t in titles:
        by_corps.setdefault(t["corps"], []).append(t)

    index, logs = [], {}
    for name in sorted(by_corps):
        mine = sorted(by_corps[name], key=lambda t: (t["year"], sort_classes([t["cls"]])[0]))
        perfs = [{"y": t["year"], "d": None, "ev": event_name(t["year"]),
                  "cls": t["cls"], "p": 1, "s": t["score"]} for t in mine]
        years = sorted({t["year"] for t in mine})
        scores = [t["score"] for t in mine if t["score"] is not None]
        # one series point per season: the best winning score that season, and
        # the class it was won in (the highest-ranked one if two were won)
        series = []
        for y in years:
            same = [t for t in mine if t["year"] == y]
            ys = [t["score"] for t in same if t["score"] is not None]
            best_cls = sort_classes([t["cls"] for t in same])[0]
            series.append([y, max(ys) if ys else None, best_cls])
        index.append({
            "name": name,
            "slug": slug_of(name),
            "first": years[0],
            "last": years[-1],
            "seasons": len(years),
            "best": max(scores) if scores else None,
            "n": len(mine),
            "series": series,
        })
        logs[name] = perfs
    return index, logs


def build_records(titles):
    """records.json — {class: {top: [[y, date, corps, score, event]],
                              finals: {year: [[corps, score]]}}}

    `top` is every winning score in the class, best first: the Records view's
    "Highest Scores Ever" table. `finals` is the champion of each season, which
    is what the same view counts titles, dynasties and title spans out of.
    """
    out = {}
    for cls in sort_classes({t["cls"] for t in titles}):
        mine = [t for t in titles if t["cls"] == cls]
        top = sorted([t for t in mine if t["score"] is not None],
                     key=lambda t: (-t["score"], t["year"], t["corps"]))
        out[cls] = {
            "top": [[t["year"], None, t["corps"], t["score"], event_name(t["year"])] for t in top],
            "finals": {str(t["year"]): [[t["corps"], t["score"]]] for t in mine},
        }
    return out


def build_rankings(titles, schedule_years):
    """rankings.json — the most recent World Championships as the standings,
    one class per block, plus the winning-score-by-year series the board's
    chart is drawn from.

    Every row is the reigning champion of its class. The supporting numbers on
    the row (their title count, their previous title and the gap to it, their
    best winning score) are all counted off that ensemble's other real titles
    in the same class.
    """
    if not titles:
        return {"kind": "championship", "season": None, "standings": {}, "winners": {}}
    season = max(t["year"] for t in titles)
    standings, winners = {}, {}
    for cls in sort_classes({t["cls"] for t in titles}):
        mine = sorted([t for t in titles if t["cls"] == cls], key=lambda t: t["year"])
        winners[cls] = [[t["year"], t["corps"], t["score"]] for t in mine]
        reigning = [t for t in mine if t["year"] == season]
        rows = []
        for t in reigning:
            theirs = [x for x in mine if x["corps"] == t["corps"]]
            scored = [x for x in theirs if x["score"] is not None]
            best = max(scored, key=lambda x: x["score"]) if scored else None
            prior = [x for x in theirs if x["year"] < t["year"]]
            prev = prior[-1] if prior else None
            delta = (None if prev is None or prev["score"] is None or t["score"] is None
                     else round(t["score"] - prev["score"], 3))
            rows.append({
                "corps": t["corps"],
                "score": t["score"],
                "date": None,                 # the record publishes no dates
                "event": event_name(t["year"]),
                "class": cls,
                "home_class": cls,
                "rank": 1,
                "outings": len(theirs),       # titles in this class
                "titles": [x["year"] for x in theirs],
                "trend": [[x["year"], x["score"]] for x in theirs],
                "prev_title": prev["year"] if prev else None,
                "prev_score": prev["score"] if prev else None,
                "delta": delta,
                "high": best["score"] if best else None,
                "high_year": best["year"] if best else None,
                "high_event": event_name(best["year"]) if best else None,
                "high_date": None,
            })
        rows.sort(key=lambda r: (-(r["score"] if r["score"] is not None else -1), r["corps"]))
        standings[cls] = {"rows": rows}
    return {
        "kind": "championship",
        "season": season,
        "seasons": sorted({t["year"] for t in titles}),
        "schedule_seasons": sorted(schedule_years),
        "standings": standings,
        "winners": winners,
    }


def build_db(titles):
    """db/index.json + db/perfs_<decade>.json — the Database tab's dataset.
    Columns match DB_SETS.scores: [Year, Date, Event, Corps, Class, Place, Score]."""
    rows = [[t["year"], None, event_name(t["year"]), t["corps"], t["cls"], 1, t["score"]]
            for t in sorted(titles, key=lambda t: (t["year"], sort_classes([t["cls"]])[0], t["corps"]))]
    parts = {}
    for r in rows:
        parts.setdefault(f"{(r[0] // 10) * 10}s", []).append(r)
    index = [{"decade": k, "rows": len(v)} for k, v in sorted(parts.items())]
    return index, parts


# ── provenance assertions ───────────────────────────────────────────────────
def assert_traceable(app, titles, index, logs, records, rankings, db_parts):
    """Every derived row must be one of the real title rows. This is the whole
    point of the script, so it is checked here rather than trusted — a builder
    that quietly invents a row is the failure mode that scripts/
    purge_fabricated.py had to clean up once already."""
    keys = {title_key(t) for t in titles}
    names = {t["corps"] for t in titles}
    ev = {t["year"]: event_name(t["year"]) for t in titles}

    def bad(what, detail):
        raise AssertionError(f"{app}: {what} does not trace to a real champion row: {detail}")

    # per-ensemble logs
    for name, perfs in logs.items():
        if name not in names:
            bad("corps log", f"{name!r} never won a title")
        for p in perfs:
            if (p["y"], p["cls"], name, p["s"]) not in keys:
                bad("performance", f"{name} {p}")
            if p["p"] != 1:
                bad("performance place", f"{name} {p} — every derived row is a title (place 1)")
            if p["d"] is not None:
                bad("performance date", f"{name} {p} — the record publishes no dates")
            if p["ev"] != ev[p["y"]]:
                bad("performance event", f"{name} {p}")

    # index: no ensemble may gain a season it did not win
    won_years = {}
    for t in titles:
        won_years.setdefault(t["corps"], set()).add(t["year"])
    for c in index:
        if c["name"] not in names:
            bad("index entry", c["name"])
        got = {s[0] for s in c["series"]}
        if got != won_years[c["name"]]:
            bad("index series", f"{c['name']}: {sorted(got)} vs won {sorted(won_years[c['name']])}")
        for y, s, cls in c["series"]:
            if s is not None and (y, cls, c["name"], s) not in keys:
                bad("index series row", f"{c['name']} {y} {cls} {s}")
        if c["seasons"] != len(won_years[c["name"]]) or c["n"] != len([t for t in titles if t["corps"] == c["name"]]):
            bad("index counts", c["name"])
        if c["first"] != min(won_years[c["name"]]) or c["last"] != max(won_years[c["name"]]):
            bad("index span", c["name"])

    # records
    for cls, blk in records.items():
        for y, d, corps, score, evname in blk["top"]:
            if (y, cls, corps, score) not in keys:
                bad("records.top", f"{cls} {y} {corps} {score}")
            if d is not None or evname != ev[y]:
                bad("records.top row", f"{cls} {y} {corps}")
        for y, rows in blk["finals"].items():
            for corps, score in rows:
                if (int(y), cls, corps, score) not in keys:
                    bad("records.finals", f"{cls} {y} {corps} {score}")

    # rankings
    season = rankings.get("season")
    for cls, blk in rankings["standings"].items():
        for r in blk["rows"]:
            if (season, cls, r["corps"], r["score"]) not in keys:
                bad("standings row", f"{cls} {r['corps']} {r['score']}")
            for y, s in r["trend"]:
                if (y, cls, r["corps"], s) not in keys:
                    bad("standings trend", f"{cls} {r['corps']} {y}")
            if r["prev_score"] is not None and (r["prev_title"], cls, r["corps"], r["prev_score"]) not in keys:
                bad("standings prev title", f"{cls} {r['corps']}")
            if r["high"] is not None and (r["high_year"], cls, r["corps"], r["high"]) not in keys:
                bad("standings high", f"{cls} {r['corps']}")
    for cls, rows in rankings["winners"].items():
        for y, corps, score in rows:
            if (y, cls, corps, score) not in keys:
                bad("winners row", f"{cls} {y} {corps}")

    # database
    seen = 0
    for decade, rows in db_parts.items():
        for y, d, evname, corps, cls, place, score in rows:
            if (y, cls, corps, score) not in keys:
                bad("database row", f"{y} {cls} {corps} {score}")
            if d is not None or place != 1 or evname != ev[y]:
                bad("database row shape", f"{y} {cls} {corps}")
            seen += 1
    if seen != len(titles):
        bad("database", f"{seen} rows for {len(titles)} titles")


# ── writing ─────────────────────────────────────────────────────────────────
def build_app(app: str, write: bool = True):
    """Derive one app's datasets. Returns a report dict, or None when the
    LIVE-marker contract says this tree is not ours to write."""
    d = DOCS / app / "data"
    reason = refusal_reason(d)
    if reason:
        return {"app": app, "skipped": reason}

    titles = read_titles(d)
    schedule_years = sorted(int(f.stem) for f in (d / "seasons").glob("*.json")
                            if f.stem.isdigit()) if (d / "seasons").exists() else []

    index, logs = build_corps(titles)
    records = build_records(titles)
    rankings = build_rankings(titles, schedule_years)
    db_index, db_parts = build_db(titles)
    assert_traceable(app, titles, index, logs, records, rankings, db_parts)

    planned = {
        d / "corps_index.json": index,
        d / "records.json": records,
        d / "rankings.json": rankings,
        d / "db" / "index.json": db_index,
    }
    # the top-bar freshness chip prints "Updated <meta.updated>". These trees
    # carried the demo era's "updated": "preview", which said nothing true;
    # what this data actually is, is the record through its last season.
    # meta.seasons is the SCHEDULE's and is left exactly as published.
    meta = load(d / "meta.json")
    if isinstance(meta, dict) and titles:
        meta = dict(meta)
        meta["updated"] = f"through {max(t['year'] for t in titles)}"
        planned[d / "meta.json"] = meta
    for name, perfs in logs.items():
        planned[d / "corps" / f"{slug_of(name)}.json"] = {"name": name, "performances": perfs}
    for decade, rows in db_parts.items():
        planned[d / "db" / f"perfs_{decade}.json"] = rows

    # stale files: an ensemble that leaves the record, or a renamed slug
    keep = {p.name for p in planned if p.parent.name == "corps"}
    stale = [f for f in sorted((d / "corps").glob("*.json")) if f.name not in keep] \
        if (d / "corps").exists() else []
    keep_db = {p.name for p in planned if p.parent.name == "db"}
    stale += [f for f in sorted((d / "db").glob("*.json")) if f.name not in keep_db] \
        if (d / "db").exists() else []

    changed = []
    for path, body in planned.items():
        text = json.dumps(body, ensure_ascii=False)
        if not path.exists() or path.read_text() != text:
            changed.append(path)
            if write:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
    if write:
        for f in stale:
            f.unlink()
        # provenance, next to the markers this script answers to
        (d / "DERIVED").write_text(
            "corps_index.json, corps/*.json, records.json, rankings.json and db/*\n"
            "are derived from champions.json by scripts/build_wgi_datasets.py.\n"
            f"{len(titles)} championship titles · {len(index)} ensembles · "
            f"{len(records)} classes · {min((t['year'] for t in titles), default=0)}"
            f"–{max((t['year'] for t in titles), default=0)}\n"
            "No dates: the published record carries none, so every derived date is null.\n"
            "scripts/purge_fabricated.py --rebuild resets these files to the empty\n"
            "state (it predates this derivation and only counts season results);\n"
            "re-run this script, or gen_family_data.py, to rebuild them.\n")

    return {
        "app": app, "titles": len(titles), "ensembles": len(index),
        "classes": len(records), "seasons": len({t["year"] for t in titles}),
        "changed": [str(p.relative_to(DOCS)) for p in changed],
        "stale_removed": [str(p.relative_to(DOCS)) for p in stale] if write else [],
    }


def main() -> int:
    check = "--check" in sys.argv
    dry = "--dry-run" in sys.argv or "-n" in sys.argv
    write = not (check or dry)
    rc = 0
    for app in APPS:
        r = build_app(app, write=write)
        if r.get("skipped"):
            print(f"{app:16} SKIPPED — {r['skipped']}")
            continue
        print(f"{app:16} {r['titles']:4} titles · {r['ensembles']:4} ensembles · "
              f"{r['classes']} classes · {r['seasons']} seasons"
              + (f" · {len(r['changed'])} file(s) {'would change' if not write else 'written'}"
                 if r["changed"] else " · up to date")
              + (f" · {len(r['stale_removed'])} stale removed" if r["stale_removed"] else ""))
        if r["changed"]:
            for p in r["changed"][:6]:
                print(f"                   ~ {p}")
            if len(r["changed"]) > 6:
                print(f"                   ~ …and {len(r['changed']) - 6} more")
            if check:
                rc = 1
    if check and rc:
        print("\n--check: derived files are out of date (or not idempotent). "
              "Run scripts/build_wgi_datasets.py.")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
