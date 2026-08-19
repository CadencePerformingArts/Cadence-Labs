"""Fast integrity gate for the generated site data (docs/data + docs/onthisday.json).

Runs after every build (scraper/run_all.sh) and before every Pages deploy
(pages.yml), so a broken or truncated build can never silently replace good
published data. Designed to finish in a couple of seconds — it validates
structure, arithmetic, and plausibility, not completeness of history.

Exit 0 = safe to publish. Exit 1 = refuse to deploy (previous data stays live).
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DATA = DOCS / "data"

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def load(path: Path, min_bytes: int = 2):
    """Parse JSON; a missing/tiny/HTML-ish file is an immediate finding."""
    if not path.exists():
        fail(f"{path.relative_to(ROOT)}: missing")
        return None
    raw = path.read_bytes()
    if len(raw) < min_bytes:
        fail(f"{path.relative_to(ROOT)}: suspiciously small ({len(raw)} bytes)")
        return None
    head = raw[:200].lstrip().lower()
    if head.startswith(b"<") or b"cloudflare" in head or b"<!doctype" in head:
        fail(f"{path.relative_to(ROOT)}: looks like an HTML/challenge page, not JSON")
        return None
    try:
        return json.loads(raw)
    except Exception as e:
        fail(f"{path.relative_to(ROOT)}: JSON parse error — {e}")
        return None


ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def check_score(s, where: str, allow_none=True):
    if s is None:
        if not allow_none:
            fail(f"{where}: score is null")
        return
    if not isinstance(s, (int, float)) or not (0 <= float(s) <= 100):
        fail(f"{where}: implausible score {s!r}")


def main() -> int:
    meta = load(DATA / "meta.json", 50)
    season_years: set[int] = set()
    newest_year = None
    if meta is not None:
        try:
            dt.datetime.strptime(meta.get("updated", ""), "%Y-%m-%d %H:%M UTC")
        except Exception:
            fail(f"meta.json: bad updated stamp {meta.get('updated')!r}")
        season_years = {s.get("year") for s in meta.get("seasons", []) if isinstance(s.get("year"), int)}
        if not season_years:
            fail("meta.json: no seasons listed")
        else:
            newest_year = max(season_years)

    # ---- rankings ----------------------------------------------------------
    rk = load(DATA / "rankings.json", 1000)
    known_corps: set[str] = set()
    if rk is not None:
        total_rows = 0
        for cls, block in (rk.get("standings") or {}).items():
            rows = block.get("rows") or []
            total_rows += len(rows)
            seen = set()
            for r in rows:
                c = r.get("corps")
                if not c:
                    fail(f"rankings[{cls}]: row without corps")
                    continue
                known_corps.add(c)
                if c in seen:
                    fail(f"rankings[{cls}]: duplicate corps row '{c}'")
                seen.add(c)
                check_score(r.get("score"), f"rankings[{cls}] {c}", allow_none=False)
                if r.get("date") and not ISO.match(str(r["date"])):
                    fail(f"rankings[{cls}] {c}: bad date {r['date']!r}")
                for t in r.get("trend") or []:
                    if not (isinstance(t, list) and len(t) == 2 and ISO.match(str(t[0]))):
                        fail(f"rankings[{cls}] {c}: malformed trend point {t!r}")
                        break
        # shrink guard: a real season never has fewer than ~2 shows of corps;
        # early June the board is small, so the bar is deliberately low
        if total_rows and total_rows < 8:
            fail(f"rankings.json: only {total_rows} rows across all classes — truncated build?")

    # ---- corps index resolves the ranked corps -----------------------------
    idx = load(DATA / "corps_index.json", 1000)
    if idx is not None and known_corps:
        names = {c.get("name") for c in idx if isinstance(c, dict)}
        slugs = {c.get("slug") for c in idx if isinstance(c, dict)}
        if len(slugs) != len([c for c in idx if isinstance(c, dict)]):
            fail("corps_index.json: duplicate slugs")
        missing = sorted(known_corps - names)
        if missing:
            fail(f"corps_index.json: ranked corps missing from the index: {', '.join(missing[:5])}")

    # ---- current season file -----------------------------------------------
    if newest_year:
        season = load(DATA / "seasons" / f"{newest_year}.json", 500)
        if season is not None:
            if not season:
                fail(f"seasons/{newest_year}.json: empty")
            for ev in season:
                where = f"seasons/{newest_year} '{ev.get('name', '?')}'"
                if not ev.get("name"):
                    fail(f"{where}: event without a name")
                if ev.get("date") and not ISO.match(str(ev["date"])):
                    fail(f"{where}: bad date {ev.get('date')!r}")
                for c in ev.get("classes") or []:
                    if not c.get("class"):
                        fail(f"{where}: class without a name")
                    for r in c.get("results") or []:
                        check_score(r.get("score"), f"{where} {r.get('corps')}")

        # caption arithmetic — the same invariant build_data enforces, re-proved
        # on the published artifact (columns: ...ge, vp, va, cg, vis, br, ma, pc,
        # mus, pen, tot — tot = ge + vis + mus - pen)
        caps = load(DATA / "captions" / f"{newest_year}.json", 2)
        if caps:
            bad = 0
            for row in caps:
                try:
                    ge, vis, mus = row[6], row[10], row[14]
                    pen, tot = row[15] or 0, row[16]
                    if None in (ge, vis, mus, tot):
                        continue
                    if abs((ge + vis + mus - pen) - tot) > 0.011:
                        bad += 1
                except Exception:
                    bad += 1
            if bad:
                fail(f"captions/{newest_year}.json: {bad} rows fail the caption arithmetic check")

    # ---- champions / records reference real seasons ------------------------
    ch = load(DATA / "champions.json", 100)
    if ch is not None and season_years:
        for y in ch:
            if not (str(y).isdigit() and 1920 < int(y) <= max(season_years)):
                fail(f"champions.json: implausible year key {y!r}")

    load(DATA / "records.json", 100)
    load(DATA / "news.json", 2)
    load(DATA / "offseason.json", 2)

    # ---- upcoming ----------------------------------------------------------
    up = load(DATA / "upcoming.json", 1)
    if isinstance(up, list):
        for ev in up:
            if ev.get("date") and not ISO.match(str(ev["date"])):
                fail(f"upcoming.json '{ev.get('name')}': bad date {ev.get('date')!r}")
            if ev.get("kind") not in (None, "camp", "auditions", "special"):
                fail(f"upcoming.json '{ev.get('name')}': unknown kind {ev.get('kind')!r}")

    # ---- static assets the app depends on ----------------------------------
    for p in ("onthisday.json",):
        load(DOCS / p, 100)
    for icon in ("icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/badge-96.png"):
        if not (DOCS / icon).exists():
            fail(f"docs/{icon}: missing")

    if problems:
        print(f"DATA VALIDATION FAILED — {len(problems)} problem(s):")
        for p in problems:
            print("  -", p)
        return 1
    print("data validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
