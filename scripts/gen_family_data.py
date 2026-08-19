#!/usr/bin/env python3
"""Normalise the shipped Cadence family datasets (docs/wgi/*/data).

Fabricated scores are retired: every family app now carries real ingested
data or an honest empty state, so this script no longer *generates* results.
What it does is make the published files match the shapes the shared engine
(docs/family/app.js, derived from docs/app.js) actually reads. Those files
arrive from two directions — scraper/scrape_wgi.py for live ingests and
scripts/purge_fabricated.py for the empty-state rebuild — and the seams
between them are where the app breaks:

  * ensemble names arrive HTML-escaped from scraped pages, so
    "St. Anthony&#8217;s Queens" renders literally, entity and all;
  * corps_index slugs were built with a different slugifier than the app's
    `slugOf()`, so "Arlington HS (NY)" indexed as "arlington-hs-(ny)" — a
    slug the router's [a-z0-9-]+ pattern cannot even match;
  * corps_index listed 152 ensembles for 39 corps/<slug>.json files, so most
    profile links 404'd;
  * records.json was flattened to {"top": [], "finals": []}, which the
    Records view reads as two classes named "top" and "finals" and then
    throws on;
  * profiles.json still carried preview-era summaries that claimed
    championships nobody won.

Everything here is idempotent — it runs on every deploy (pages.yml) and a
second run changes nothing.

    python3 scripts/gen_family_data.py
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# the shipped family apps, in menu order
APPS = ["wgi/guard", "wgi/percussion", "wgi/winds"]

# summaries written by the retired demo generator — they assert seasons and
# championships that never happened, so they must never survive a run
FABRICATED_SUMMARY = re.compile(r"Preview data|Preview-season champion|placeholders until the live feed")

ENTITY = re.compile(r"&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);")


def slug_of(name: str) -> str:
    """Mirrors slugOf() in docs/app.js (and slug() in apply_logo_overrides.py).
    The router only accepts [a-z0-9-]+, so every stored slug must round-trip
    through this or its links are unreachable."""
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def clean_text(s: str) -> str:
    """Decode scraped HTML entities and normalise the whitespace they bring
    along. URLs and data: URIs are passed through untouched — percent-encoded
    payloads must not be rewritten."""
    if not s or s.startswith(("data:", "http://", "https://", "//")):
        return s
    # scraped pages are occasionally double-escaped ("&amp;#8217;")
    for _ in range(3):
        if not ENTITY.search(s):
            break
        nxt = html.unescape(s)
        if nxt == s:
            break
        s = nxt
    s = s.replace(" ", " ").replace("​", "")
    return re.sub(r"[ \t]+", " ", s).strip()


def clean_deep(node):
    if isinstance(node, dict):
        return {k: clean_deep(v) for k, v in node.items()}
    if isinstance(node, list):
        return [clean_deep(v) for v in node]
    if isinstance(node, str):
        return clean_text(node)
    return node


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def dump(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj))


def names_in(data_dir: Path) -> dict:
    """Every ensemble name this app knows about -> the name as published.
    Sources: the champion record, each season's results and lineups, and the
    upcoming schedule's lineups."""
    names = {}

    def add(n):
        if isinstance(n, str):
            n = clean_text(n)
            if n:
                names[n] = n

    champs = load(data_dir / "champions.json") or {}
    for by_cls in champs.values():
        if isinstance(by_cls, dict):
            for w in by_cls.values():
                if isinstance(w, dict):
                    add(w.get("corps"))
    for f in sorted((data_dir / "seasons").glob("*.json")) if (data_dir / "seasons").exists() else []:
        for ev in load(f) or []:
            for c in ev.get("classes") or []:
                for r in c.get("results") or []:
                    add(r.get("corps"))
            for n in ev.get("lineup") or []:
                add(n)
    for ev in load(data_dir / "upcoming.json") or []:
        for n in ev.get("lineup") or []:
            add(n)
    for c in load(data_dir / "corps_index.json") or []:
        add(c.get("name"))
    return names


def performance_logs(data_dir: Path) -> dict:
    """Rebuild every ensemble's performance log from the published season
    files, which are this app's only source of truth for results.

    The corps/<slug>.json logs are derived data, and they had drifted: the
    WGI apps still carried five invented 2022-2026 seasons per ensemble from
    the retired demo generator, under real ensemble names, even though the
    only published season is 2027's schedule. Deriving the logs here means a
    result exists on a profile if and only if it exists in a season file."""
    logs: dict = {}
    seasons = data_dir / "seasons"
    for f in sorted(seasons.glob("*.json")) if seasons.exists() else []:
        year = int(f.stem) if f.stem.isdigit() else None
        for ev in load(f) or []:
            y = year if year is not None else int(str(ev.get("date") or "0")[:4] or 0)
            for c in ev.get("classes") or []:
                for r in c.get("results") or []:
                    name = clean_text(str(r.get("corps") or ""))
                    if not name:
                        continue
                    logs.setdefault(name, []).append({
                        "y": y, "d": ev.get("date"), "ev": ev.get("name"),
                        "cls": c.get("class"), "p": r.get("place"), "s": r.get("score"),
                    })
    for lst in logs.values():
        lst.sort(key=lambda p: (p["y"], p["d"] or ""))
    return logs


def normalise_profiles(d: Path) -> None:
    """profiles: keyed by the app slug, no invented history."""
    profs = load(d / "profiles.json") or {}
    out = {}
    for key, p in profs.items():
        if not isinstance(p, dict):
            continue
        title = clean_text(str(p.get("title") or key))
        p = dict(p)
        p["title"] = title
        if FABRICATED_SUMMARY.search(str(p.get("summary") or "")):
            p.pop("summary", None)
        # a profile that is nothing but a generated monogram still earns its
        # place: corpsLogo() reads `img` for every avatar in the app
        if p:
            out[slug_of(title)] = p
    if out != profs:
        dump(d / "profiles.json", out)


def normalise(app: str) -> None:
    d = DOCS / app / "data"
    if not d.exists():
        print(f"{app}: no data directory — skipped")
        return

    # ---- 1. decode entities / whitespace everywhere the reader can see ----
    touched = 0
    files = [d / n for n in ("champions.json", "corps_index.json", "profiles.json",
                             "upcoming.json", "rankings.json", "records.json", "meta.json")]
    files += sorted((d / "seasons").glob("*.json")) if (d / "seasons").exists() else []
    files += sorted((d / "corps").glob("*.json")) if (d / "corps").exists() else []
    for f in files:
        if not f.exists():
            continue
        cur = load(f)
        if cur is None:
            continue
        new = clean_deep(cur)
        if new != cur:
            dump(f, new)
            touched += 1

    # ---- 2. records.json: a per-class map, or nothing ----
    # The Records view treats every top-level key as a class name. A flat
    # {"top": [], "finals": []} therefore renders classes called "top" and
    # "finals" and throws reading rec["top"].top. An empty object is the
    # honest shape for an app with no record book yet.
    rec = load(d / "records.json")
    if not isinstance(rec, dict) or not all(
            isinstance(v, dict) and "top" in v for v in rec.values()):
        dump(d / "records.json", {})

    # ---- 3. db/index.json: a list of {decade, rows} ----
    dbi = load(d / "db" / "index.json")
    if not isinstance(dbi, list):
        dump(d / "db" / "index.json", [])

    # ---- 4. corps_index + per-ensemble logs, both derived from the seasons ----
    # …unless this app has no season results at all and does have a real
    # championship record, in which case scripts/build_wgi_datasets.py owns
    # these files and derives them from that record instead. Exactly one
    # writer per tree: it refuses the moment a richer ingest lands (see
    # build_wgi_datasets.refusal_reason), and this branch takes over again.
    import build_wgi_datasets as bwd
    if bwd.refusal_reason(d) is None:
        r = bwd.build_app(app)
        print(f"{app}: {touched} files cleaned · derived from the championship record "
              f"({r['titles']} titles · {r['ensembles']} ensembles · {r['classes']} classes, "
              f"{len(r['changed'])} file(s) written)")
        normalise_profiles(d)
        return

    # Slug parity matters as much as the numbers: the router only matches
    # [a-z0-9-]+, so an index slug the app's slugOf() would never produce
    # ("arlington-hs-(ny)") is a link that cannot resolve.
    known = names_in(d)
    logs = performance_logs(d)
    idx = []
    for name in sorted(known):
        plist = logs.get(name, [])
        scored = [p["s"] for p in plist if p["s"] is not None]
        yrs = sorted({p["y"] for p in plist})
        series = [[y,
                   max((p["s"] for p in plist if p["y"] == y and p["s"] is not None), default=None),
                   next((p["cls"] for p in plist if p["y"] == y), None)] for y in yrs]
        idx.append({
            "name": name,
            "slug": slug_of(name),
            "first": yrs[0] if yrs else None,
            "last": yrs[-1] if yrs else None,
            "seasons": len(yrs),
            "best": max(scored) if scored else None,
            "n": len(plist),
            "series": series,
        })
    dump(d / "corps_index.json", idx)

    # renderCorpsDetail fetches corps/<slug>.json; a missing file is a 404 in
    # the console and a "no scores on record" card. The card is the right
    # answer — the 404 is not, so ship the empty log explicitly.
    corps_dir = d / "corps"
    corps_dir.mkdir(exist_ok=True)
    keep = {f"{e['slug']}.json" for e in idx}
    written = removed = 0
    for entry in idx:
        want = corps_dir / f"{entry['slug']}.json"
        body = {"name": entry["name"], "performances": logs.get(entry["name"], [])}
        if load(want) != body:
            dump(want, body)
            written += 1
    # stale files (old slugs, ensembles no longer in any published season)
    for f in sorted(corps_dir.glob("*.json")):
        if f.name not in keep:
            f.unlink()
            removed += 1

    normalise_profiles(d)

    print(f"{app}: {len(idx)} ensembles · {touched} files cleaned · "
          f"{written} logs written, {removed} stale removed · "
          f"{dropped} invented summaries dropped")


def reapply_logos() -> None:
    """Re-apply the curated real-logo overrides (data/logos/overrides.json)
    so a normalisation pass can never wipe them back to generated monograms.

    apply_logo_overrides.main() walks every app in the override file,
    including DCI; this script owns the family datasets only, so it reuses
    that module's helpers and stays inside APPS. Run the script itself
    (`python3 scripts/apply_logo_overrides.py`) to cover DCI too."""
    import apply_logo_overrides as alo
    if not alo.OVERRIDES.exists():
        print("logo overrides: none found")
        return
    entries = [e for e in json.loads(alo.OVERRIDES.read_text()) if e.get("app") in APPS]
    by_app = {}
    for e in entries:
        by_app.setdefault(e["app"], []).append(e)
    for app, evs in sorted(by_app.items()):
        ppath = alo.profiles_path(app)
        if not ppath.exists():
            continue
        profs = json.loads(ppath.read_text())
        changed = 0
        for e in evs:
            prof = profs.get(alo.slug(e["name"]))
            if prof is None:
                print(f"logo overrides: {app}: no profile for {e['name']!r} — skipped")
                continue
            new = {"img": alo.resolve_img(app, e["img"]),
                   "img_source": e.get("source"), "img_license": e.get("license")}
            if any(prof.get(k) != v for k, v in new.items()):
                changed += 1
            prof.update(new)
        if changed:
            ppath.write_text(alo.dumps_like(ppath, profs))
        print(f"logo overrides: {app}: {len(evs)} applied ({changed} changed)")


def main() -> None:
    for app in APPS:
        normalise(app)
    reapply_logos()


if __name__ == "__main__":
    main()
