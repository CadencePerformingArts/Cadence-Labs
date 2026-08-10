#!/usr/bin/env python3
"""Remove every fabricated score from the shipped datasets.

Early in the build, apps without a real data feed were populated by a demo
generator: real ensemble names attached to invented scores, tagged
`"source": "demo"`. That was scaffolding, and it outlived its purpose — the
WGI apps were showing five seasons of made-up results, and BOA had eight
fabricated 2026 events sitting beside 49 years of genuine recaps.

This script deletes all of it and rebuilds each affected app from whatever
is genuinely real (champions history, published schedules), so an app with
no score feed shows an honest empty scoreboard instead of fiction.

    python3 scripts/purge_fabricated.py
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
APPS = ["wgi/guard", "wgi/percussion", "wgi/winds", "boa", "usbands",
        "uil", "wgasc", "tcgc", "ffcc", ""]


def load(p):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def dump(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False))


def purge_app(key, rebuild=False):
    d = DOCS / (key + "/data" if key else "data")
    if not d.exists():
        return None
    seasons_dir = d / "seasons"
    removed_files, removed_rows, kept_years = [], 0, []

    for f in sorted(seasons_dir.glob("*.json")) if seasons_dir.exists() else []:
        rows = load(f)
        if not isinstance(rows, list):
            continue
        real = [ev for ev in rows if ev.get("source") != "demo"]
        fake_rows = sum(len(c.get("results") or [])
                        for ev in rows if ev.get("source") == "demo"
                        for c in (ev.get("classes") or []))
        if len(real) == len(rows):
            kept_years.append(int(f.stem))
            continue
        removed_rows += fake_rows
        if real:
            dump(f, real)
            kept_years.append(int(f.stem))
            removed_files.append(f"{f.stem} (partial)")
        else:
            f.unlink()
            removed_files.append(f.stem)

    if not removed_files and not rebuild:
        return None  # nothing fabricated here

    # what's genuinely real, after the purge
    scored = {}
    for y in kept_years:
        rows = load(seasons_dir / f"{y}.json") or []
        n = sum(len(c.get("results") or [])
                for ev in rows for c in (ev.get("classes") or []))
        scored[y] = n

    # ── rebuild the derived files from real data only ──────────────────
    champs = load(d / "champions.json") or {}
    upcoming = load(d / "upcoming.json") or []

    names = set()

    def harvest(node):
        """champions.json shapes vary by app: {year:{class:{corps,score}}},
        {class:[{corps,…}]}, or a flat list. Walk whatever is there."""
        if isinstance(node, dict):
            if node.get("corps"):
                names.add(node["corps"])
            else:
                for v in node.values():
                    harvest(v)
        elif isinstance(node, list):
            for v in node:
                harvest(v)

    harvest(champs)
    for y in kept_years:
        for ev in (load(seasons_dir / f"{y}.json") or []):
            for c in (ev.get("classes") or []):
                for r in (c.get("results") or []):
                    if r.get("corps"):
                        names.add(r["corps"])
            for n in (ev.get("lineup") or []):
                names.add(n)
    for ev in upcoming:
        for n in (ev.get("lineup") or []):
            names.add(n)

    has_scores = any(scored.values())
    if not has_scores:
        # no real score feed: an empty board is the truthful answer
        dump(d / "rankings.json", {"standings": {}})
        dump(d / "records.json", {"top": [], "finals": []})
        old_index = {c.get("name"): c for c in (load(d / "corps_index.json") or [])}
        idx = []
        for n in sorted(names):
            prev = old_index.get(n) or {}
            idx.append({"name": n, "slug": prev.get("slug") or n.lower().replace(" ", "-"),
                        "first": None, "last": None, "seasons": 0,
                        "best": None, "n": 0, "series": []})
        dump(d / "corps_index.json", idx)
        # per-ensemble files carried fabricated performance logs
        for f in (d / "corps").glob("*.json") if (d / "corps").exists() else []:
            cur = load(f) or {}
            cur["perfs"] = []
            cur["series"] = []
            dump(f, cur)
        db = d / "db"
        if db.exists():
            shutil.rmtree(db)
        dump(d / "db" / "index.json", {"decades": [], "rows": 0})

    # only rewrite meta when this app actually changed — untouched apps (DCI
    # especially, whose meta.json is owned by the live-scores job) must not be
    # rewritten just because a rebuild pass ran
    if removed_files or not has_scores:
        meta = load(d / "meta.json") or {}
        meta["seasons"] = [{"year": y, "events": len(load(seasons_dir / f"{y}.json") or [])}
                           for y in sorted(kept_years)]
        dump(d / "meta.json", meta)

    # stop the demo generator from ever refilling this app
    if removed_files or not has_scores:
        (d / "LIVE").write_text("real data only — see scripts/purge_fabricated.py\n")

    return {"app": key or "dci", "removed_seasons": removed_files,
            "removed_rows": removed_rows, "kept_years": sorted(kept_years),
            "real_scored_rows": sum(scored.values()), "ensembles": len(names)}


def main():
    import sys
    # --rebuild also refreshes apps that are already clean but have no score
    # feed, so their ensemble lists track real champions and schedules
    rebuild = "--rebuild" in sys.argv
    results = [r for r in (purge_app(k, rebuild) for k in APPS) if r]
    if not results:
        print("no fabricated data found — nothing to purge")
        return
    for r in results:
        print(f"{r['app']:16} removed {r['removed_rows']:5} invented scores "
              f"from {len(r['removed_seasons'])} season file(s) "
              f"{r['removed_seasons']} · kept years {r['kept_years']} "
              f"({r['real_scored_rows']} real rows, {r['ensembles']} ensembles)")


if __name__ == "__main__":
    main()
