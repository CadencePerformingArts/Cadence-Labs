#!/usr/bin/env python3
"""Patch real ensemble logos into every app's profiles.json.

data/logos/overrides.json is the single source of truth for legitimately
licensed real logos (each entry records the Wikimedia Commons source page and
its verified license). This script rewrites the `img` field of the matching
profile in each app's data/profiles.json, so the curated logos survive any
dataset regeneration — gen_family_data.py calls this at the end of its main(),
and it is safe (idempotent) to run by hand after any other regeneration:

    python3 scripts/apply_logo_overrides.py

Path handling: profiles.json `img` values are used verbatim as <img src> by
docs/app.js and docs/family/app.js, so a relative path resolves against the
page that loaded the app (docs/ for DCI, docs/wgi/guard/ for WGI guard, ...).
Overrides therefore store the img as docs-root-relative ("logos/foo.svg") and
this script prepends the right number of "../" per app. Full data: URIs and
http(s) URLs are passed through untouched. The "logos/..." spelling also
matters: the apps' isLogoUrl() only treats a URL as a logo when it contains
".svg" or a word like "logo", which every rewritten path satisfies.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OVERRIDES = ROOT / "data" / "logos" / "overrides.json"


def slug(name: str) -> str:
    # must match slugOf() in docs/app.js + docs/family/app.js and slug() in
    # gen_family_data.py — profiles.json is keyed by this
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def profiles_path(app: str) -> Path:
    return (DOCS / "data" if app == "dci" else DOCS / app / "data") / "profiles.json"


def resolve_img(app: str, img: str) -> str:
    if img.startswith(("data:", "http://", "https://")):
        return img
    depth = 0 if app == "dci" else len(app.strip("/").split("/"))
    return "../" * depth + img.lstrip("/")


def dumps_like(path: Path, obj) -> str:
    # keep each file's existing JSON style so reapplying is diff-clean:
    # the DCI pipeline writes compact separators, the demo generator defaults
    compact = '": ' not in path.read_text()[:2000]
    return json.dumps(obj, separators=((",", ":") if compact else (", ", ": ")))


def main() -> int:
    if not OVERRIDES.exists():
        print(f"logo overrides: {OVERRIDES} not found — nothing to apply")
        return 0
    entries = json.loads(OVERRIDES.read_text())
    by_app = {}
    for e in entries:
        by_app.setdefault(e["app"], []).append(e)

    problems = 0
    for app, evs in sorted(by_app.items()):
        ppath = profiles_path(app)
        if not ppath.exists():
            print(f"logo overrides: {app}: {ppath} missing — skipped")
            problems += 1
            continue
        profiles = json.loads(ppath.read_text())
        applied, changed = 0, 0
        for e in evs:
            key = slug(e["name"])
            prof = profiles.get(key)
            if prof is None:
                print(f"logo overrides: {app}: no profile '{key}' for name {e['name']!r} — skipped")
                problems += 1
                continue
            img = resolve_img(app, e["img"])
            if not img.startswith(("data:", "http")):
                local = DOCS / img.replace("../", "")
                if not local.exists():
                    print(f"logo overrides: {app}: {local} missing for {e['name']!r} — skipped")
                    problems += 1
                    continue
            # keep the license paper trail next to the image it covers
            new = {"img": img, "img_source": e.get("source"), "img_license": e.get("license")}
            if any(prof.get(k) != v for k, v in new.items()):
                changed += 1
            prof.update(new)
            applied += 1
        if changed:
            ppath.write_text(dumps_like(ppath, profiles))
        print(f"logo overrides: {app}: {applied} applied ({changed} changed) -> {ppath.relative_to(ROOT)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
