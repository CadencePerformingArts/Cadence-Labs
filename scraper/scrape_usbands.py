#!/usr/bin/env python3
"""USBands live ingest from usbands.org's own server-rendered score pages.

Source design (verified by the --discover probe, kept below):
  https://usbands.org/events/?year=Y          one page, every event card of the
                                              fall marching season (no
                                              pagination; the winter/other
                                              activities live behind ?type=
                                              filters and are NOT ingested)
  https://usbands.org/events/details.php?ID=N one event; the 'tab-scores'
                                              pane server-renders Competition
                                              Results as division blocks
                                              (.scores-division__name) of
                                              .scores-row entries
                                              (Rank / Band / Score)

Two modes, modeled on scrape_boa.py:

  --discover           the original CompetitionSuite-bridge probe; writes
                       data/usbands_probe.json and never touches docs/.
  --ingest --year Y    parse season Y's inline score tables into per-band
                       rows (name, class 'Group II A'..'Group VI Open',
                       score, rank), then rebuild the full app dataset in
                       docs/usbands/data/ — but ONLY if validation passes
                       (>=10 events, >=200 rows, scores 40..100, ranks
                       sequential). On success a LIVE marker stops the demo
                       generator from overwriting real results. Multi-year:
                       each ingested season is kept in live_store.json and
                       every run rebuilds seasons/<year>.json, band series,
                       records etc. across all ingested years.

Honesty & care: everything goes through the shared rate-limited fetch()
cache; these are the public score pages USBands itself publishes. A failed
or partial scrape never erases previously published data; divisions whose
ranks don't line up are dropped.
"""
from __future__ import annotations

import argparse
import hashlib
import html as htmllib
import json
import os
import re
import sys
from datetime import datetime, timezone
from itertools import zip_longest
from urllib.parse import quote, urljoin

from common import ROOT, fetch, log, norm_space, slugify
import scrape_compsuite as cs

PROBE_OUT = ROOT / "data" / "usbands_probe.json"
GUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
HREF_RE = re.compile(r'href=["\']([^"\'#]+)["\']', re.I)
HINT = re.compile(r"score|result|event|recap|competitionsuite", re.I)
ASSET_RE = re.compile(r"\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|xml|pdf)(?:\?|$)", re.I)

MAX_HOP = 12          # one-hop pages fetched, tops
MAX_CANDIDATES = 15   # candidate GUIDs tested against the bridge, tops

BASE = "https://usbands.org"
DOCS_USB = ROOT / "docs" / "usbands" / "data"
STORE = DOCS_USB / "live_store.json"


def seed_pages() -> list[str]:
    """The advertised score surfaces plus the previous season's event listing —
    USBands renders 'Competition Results' tables only on past events, so the
    prior season is where score evidence actually lives."""
    return [
        "https://usbands.org/",
        "https://usbands.org/scores/",
        "https://usbands.org/events/",
        f"https://usbands.org/events/?year={datetime.now(timezone.utc).year - 1}",
    ]


# ---------------------------------------------------------------------------
# harvest
# ---------------------------------------------------------------------------

def _score_stats(html: str) -> dict:
    """Inline score-table evidence: usbands.org renders results itself in a
    scores tab (rank/band/score rows), no CompetitionSuite embed needed."""
    return {"score_tables": len(re.findall(r'scores-division__name', html)),
            "score_rows": html.count('class="scores-row"')}


def harvest_candidates() -> tuple[list[str], dict]:
    """All GUIDs seen on usbands.org score surfaces plus one hop of
    score/result/event-ish links — candidates to test against the bridge API."""
    pages = seed_pages()
    seen: list[str] = []
    evidence: dict = {}
    per_seed_links: list[list[str]] = []
    for url in pages:
        html = fetch(url) or ""
        links: list[str] = []
        for href in HREF_RE.findall(html):
            absu = urljoin(url, href)
            if absu.startswith("http") and HINT.search(absu) and not ASSET_RE.search(absu):
                if absu not in links:
                    links.append(absu)
        evidence[url] = {"bytes": len(html),
                         "guids": sorted(set(GUID_RE.findall(html))),
                         "links": links[:40], **_score_stats(html)}
        seen += evidence[url]["guids"]
        # event detail pages first — that's where the score tables render
        per_seed_links.append([u for u in links if "details.php" in u]
                              + [u for u in links if "details.php" not in u])
    hop: list[str] = []
    for tier in zip_longest(*per_seed_links):  # round-robin across seeds
        for u in tier:
            if u and u not in pages and u not in hop and len(hop) < MAX_HOP:
                hop.append(u)
    for url in hop:
        html = fetch(url) or ""
        evidence[url] = {"hop": 1, "bytes": len(html),
                         "guids": sorted(set(GUID_RE.findall(html))),
                         **_score_stats(html)}
        seen += evidence[url]["guids"]
    ordered = list(dict.fromkeys(seen))  # de-duped, first-seen order
    return ordered, evidence


# ---------------------------------------------------------------------------
# bridge testing
# ---------------------------------------------------------------------------

def bridge_reachable() -> bool:
    """Cheap sentinel: DCI's known org GUID against GetSeasons, one attempt.
    A blocked network (403 from this sandbox) fails fast here instead of
    stalling on retry backoff for every candidate."""
    txt = fetch(f"{cs.BRIDGE}/GetSeasons/jsonp?organization={cs.DCI_ORG}",
                force=True, retries=1, accept_json=True)
    return bool(txt)


def discover() -> int:
    candidates, evidence = harvest_candidates()
    report: dict = {
        "source": "usbands",
        "probed_at": datetime.now(timezone.utc).isoformat(),
        "org_guid": None,
        "candidates": candidates,
        "evidence": evidence,
    }
    forced = os.environ.get("USBANDS_ORG_GUID")
    if forced and forced not in candidates:
        candidates = [forced] + candidates
        report["candidates"] = candidates
        report["org_guid_via_env"] = forced
    if not bridge_reachable():
        report["bridge_reachable"] = False
        report["note"] = ("CompetitionSuite bridge unreachable from this network "
                          "(expected in some sandboxes) — re-run from GitHub Actions "
                          "to test the candidate GUIDs")
    else:
        report["bridge_reachable"] = True
        report["candidates_tested"] = candidates[:MAX_CANDIDATES]
        for guid in candidates[:MAX_CANDIDATES]:
            seasons = cs._bridge(f"GetSeasons/jsonp?organization={guid}") or []
            if seasons:
                report["org_guid"] = guid
                report["org_guid_via"] = "bridge-tested candidate"
                report["seasons"] = seasons
                break
    report["pages_with_inline_scores"] = sorted(
        u for u, p in evidence.items() if p.get("score_rows"))
    PROBE_OUT.parent.mkdir(parents=True, exist_ok=True)
    PROBE_OUT.write_text(json.dumps(report, indent=1, default=str))
    n_links = sum(len(p.get("links", [])) for p in evidence.values())
    n_score_rows = sum(p.get("score_rows", 0) for p in evidence.values())
    log(f"usbands discover: {len(candidates)} candidate guids, {n_links} score-ish links, "
        f"{n_score_rows} inline score rows on {len(report['pages_with_inline_scores'])} pages, "
        f"bridge_reachable={report.get('bridge_reachable')}, "
        f"org={report['org_guid'] or 'NOT FOUND'} -> {PROBE_OUT}")
    # success = we found a usable score surface: a bridge org OR usbands' own
    # inline score tables (evidence enough to design the real adapter on)
    return 0 if (report["org_guid"] or report["pages_with_inline_scores"]) else 1


# ---------------------------------------------------------------------------
# ingest — event list -> detail pages -> inline 'tab-scores' tables
# ---------------------------------------------------------------------------

EVENT_ID_RE = re.compile(r'details\.php\?ID=(\d+)')
TITLE_RE = re.compile(r'<h1[^>]*event-title[^>]*>([^<]+)</h1>')
BADGE_RE = re.compile(r'custom-badge[^>]*>([^<]+)<')
DATE_RE = re.compile(r'calendar\.svg[^>]*/?>\s*([A-Z][a-z]+ \d{1,2},? \d{4})')
PIN_RE = re.compile(r'pin\.svg[^>]*/?>\s*([^<]+)')
DIV_RE = re.compile(r'scores-division__name">([^<]+)<')
# one .scores-row: rank-num / band (linked or plain) / numeric score; bounded
# quantifiers so a malformed row can never swallow its neighbours
SCORE_ROW_RE = re.compile(
    r'"scores-row">'
    r'.{0,300}?rank-num">(\d+)<'
    r'.{0,500}?scores-band">\s*(?:<a[^>]*>)?\s*([^<]+?)\s*(?:</a>)?\s*</div>'
    r'\s*<div class="scores-cell scores-score">\s*(-?\d+(?:\.\d+)?)\s*<', re.S)
# division label as printed: "<modifier> - Group <roman>" (e.g. 'A - Group II',
# 'Open - Group VI', 'Regional A - Group I'); anything else passes through
GROUP_LABEL_RE = re.compile(r"^\s*([A-Za-z][A-Za-z ']*?)\s*[-–]\s*Group\s+([IVX]+|\d)\s*(AA)?\s*$", re.I)
# nationals sometimes split a class into sponsor-named panels
# ('IV Open CG Conn Division', 'IV Open Selmer Division') -> one class
DIVISION_LABEL_RE = re.compile(r"^\s*([IVX]+|\d)\s+(Open|AA|A|Regional A)\b.*Division\s*$", re.I)
ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
# class tiers, best first — how the app orders divisions within a season
MOD_ORDER = ["Open", "AA", "A", "Regional A"]
# the consistent class set: normalized Group classes plus the two labels some
# championships publish results under; everything else (partner-circuit STATS
# blocks, host exhibitions, 'Performance' divisions) is dropped with a log.
CLASS_OK_RE = re.compile(r"^Group [IVX]+ (Open|AA|A|Regional A)$")
PASSTHROUGH_OK = {"Finalist", "World"}


def _roman(g: str) -> str:
    g = g.upper()
    return ROMANS[int(g) - 1] if g.isdigit() and 0 < int(g) <= len(ROMANS) else g


def norm_class(label: str) -> str:
    """'A - Group II' -> 'Group II A', 'Open - Group VI' -> 'Group VI Open',
    'Regional A - Group I' -> 'Group I Regional A', 'A - Group IIAA' ->
    'Group II AA', 'IV Open Selmer Division' -> 'Group IV Open'. Unknown
    shapes (e.g. the combined 'Finalist' block some championships publish)
    pass through."""
    s = norm_space(htmllib.unescape(label))
    m = GROUP_LABEL_RE.match(s)
    if m:
        mod = norm_space(m.group(1))
        mod = {"a": "A", "aa": "AA", "open": "Open", "regional a": "Regional A"}.get(mod.lower(), mod)
        if m.group(3):  # 'A - Group IIAA' / 'A - Group 1AA': the AA tier wins
            mod = "AA"
        return f"Group {_roman(m.group(2))} {mod}"
    m = DIVISION_LABEL_RE.match(s)
    if m:
        return f"Group {_roman(m.group(1))} {m.group(2).title().replace('Aa', 'AA')}"
    return s


def class_sort_key(cls: str) -> tuple:
    """Open before AA before A before Regional A; big groups before small;
    pass-through labels (Finalist etc.) after all real Group classes."""
    m = re.match(r"^Group ([IVX]+) (.+)$", cls)
    if not m or m.group(1) not in ROMANS:
        return (1, 0, 0, cls)
    mod = m.group(2)
    mi = MOD_ORDER.index(mod) if mod in MOD_ORDER else len(MOD_ORDER)
    return (0, mi, -ROMANS.index(m.group(1)), cls)


def display_name(band: str) -> str:
    """School names as the app shows them: '... High School' -> '... HS'."""
    n = norm_space(htmllib.unescape(band))
    n = re.sub(r"\bH\.?\s?S\.?(?=$|\s)", "HS", n)
    n = re.sub(r"\bHigh School\b", "HS", n)
    return norm_space(n).rstrip(",")


def is_national(name: str, venue: str | None, badge: str) -> bool:
    """The season's national class finals — where champions.json comes from.
    Badges alone are inconsistent (state championships carry 'Class Champs';
    the 2024 nationals carry plain 'Championships'), so: an explicit
    'National' in the name always counts, otherwise require a champs-family
    badge at a national-finals venue (J. Birney Crum Stadium in Allentown for
    A/AA class, MetLife Stadium for Open class) and a name that isn't a state
    or partner-circuit (STATS) championship."""
    n, v = name.lower(), (venue or "").lower()
    if "national" in n:
        return True
    if not badge.lower().startswith(("class champs", "championships")):
        return False
    if "state" in n or "stats" in n:
        return False
    return "birney crum" in v or "metlife" in v


def list_event_ids(year: int, *, force: bool = True) -> list[int]:
    """Every event ID on the season's (single-page) event listing."""
    html = fetch(f"{BASE}/events/?year={year}", force=force) or ""
    return sorted({int(m) for m in EVENT_ID_RE.findall(html)})


def parse_event(eid: int, year: int, *, force: bool = True) -> dict | None:
    """One detail page -> {name, date, venue, url, champ, classes:[...]}, or
    None when the page has no valid scored divisions. Divisions whose ranks
    go backwards or whose scores rise down the table (mis-parse signatures)
    are dropped and logged; rows with out-of-range scores are dropped."""
    url = f"{BASE}/events/details.php?ID={eid}"
    html = fetch(url, force=force) or ""
    divs = list(DIV_RE.finditer(html))
    if not divs:
        return None
    name = date = venue = None
    m = TITLE_RE.search(html)
    if m:
        name = norm_space(htmllib.unescape(m.group(1)))
    dm = DATE_RE.search(html)
    if dm:
        try:
            date = datetime.strptime(dm.group(1).replace(",", ""), "%B %d %Y").strftime("%Y-%m-%d")
        except ValueError:
            pass
    pm = PIN_RE.search(html)
    if pm:
        venue = norm_space(htmllib.unescape(pm.group(1))) or None
    badge = norm_space(htmllib.unescape(BADGE_RE.search(html).group(1))) if BADGE_RE.search(html) else ""
    champ = is_national(name or "", venue, badge)

    classes: dict[str, list] = {}
    for i, dv in enumerate(divs):
        block = html[dv.end():divs[i + 1].start() if i + 1 < len(divs) else dv.end() + 200_000]
        rows, seen = [], set()
        ok = True
        prev_rank, prev_score = 0, 1000.0
        for rank_s, band, score_s in SCORE_ROW_RE.findall(block):
            rank, score = int(rank_s), float(score_s)
            # published tables carry tie-skips (1,2,2,4) and gaps from
            # scratched bands (…4,6…) — a mis-parse shows up as a rank going
            # backwards or a score going up, never as a gap
            if rank < prev_rank or score > prev_score + 1e-9:
                ok = False
                break
            prev_rank, prev_score = rank, score
            band = display_name(band)
            if not band or band in seen:
                continue
            if not (40.0 <= score <= 100.0):
                log(f"  event {eid}: dropped {band} ({score}) — score out of range")
                continue
            seen.add(band)
            rows.append({"corps": band, "score": round(score, 3)})
        cls = norm_class(dv.group(1))
        if not ok:
            log(f"  event {eid}: dropped division '{cls}' — ranks/scores out of order")
            continue
        if not (CLASS_OK_RE.match(cls) or cls in PASSTHROUGH_OK):
            log(f"  event {eid}: dropped division '{cls}' — not a USBands class")
            continue
        if rows:
            classes.setdefault(cls, []).extend(rows)
    if not classes or not date or int(date[:4]) != year:
        return None
    classes_out = []
    for cls, rows in sorted(classes.items(), key=lambda kv: class_sort_key(kv[0])):
        # two printed divisions can normalize to one class — re-rank by score
        # and keep each band's best outing of the event
        best: dict[str, dict] = {}
        for r in rows:
            if r["corps"] not in best or r["score"] > best[r["corps"]]["score"]:
                best[r["corps"]] = r
        ranked = sorted(best.values(), key=lambda r: -r["score"])
        classes_out.append({"class": cls,
                            "results": [{"place": i + 1, **r} for i, r in enumerate(ranked)]})
    return {"name": name or f"USBands event {eid}", "date": date, "venue": venue,
            "url": url, "champ": champ, "classes": classes_out}


# ---------------------------------------------------------------------------
# dataset assembly — the exact format scrape_boa.assemble() publishes,
# rebuilt across every ingested season in the store.
# ---------------------------------------------------------------------------

def monogram(name: str) -> str:
    """Deterministic SVG monogram badge as a data URI (same approach as
    scripts/gen_family_data.py; '#logo.svg' satisfies isLogoUrl())."""
    base = re.sub(r"\s*\([A-Z]{2}\)$", "", name)
    h = int(hashlib.md5(f"{base}|hue".encode()).hexdigest()[:8], 16) % 360
    c1, c2 = f"hsl({h},55%,30%)", f"hsl({(h + 42) % 360},75%,52%)"
    words = [w for w in re.findall(r"[A-Za-z0-9]+", base) if w.upper() not in ("HS", "THE", "OF")]
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
    (DOCS_USB / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS_USB / "corps").mkdir(exist_ok=True)
    (DOCS_USB / "db").mkdir(exist_ok=True)

    perfs: dict[tuple[str, str], list[dict]] = {}
    season_files: dict[int, list] = {}
    champions: dict[str, dict] = {}
    db_rows = []
    for year in years:
        season_events = []
        for ev in sorted(store["years"][str(year)], key=lambda e: e["date"] or ""):
            for c in ev["classes"]:
                for r in c["results"]:
                    perfs.setdefault((c["class"], r["corps"]), []).append(
                        {"y": year, "d": ev["date"], "ev": ev["name"], "cls": c["class"],
                         "p": r["place"], "s": r["score"], "champ": bool(ev.get("champ"))})
                    db_rows.append([year, ev["date"], ev["name"], r["corps"],
                                    c["class"], r["place"], r["score"]])
            season_events.append({
                "name": ev["name"], "date": ev["date"],
                "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
                "location": ev.get("venue"), "url": ev.get("url"), "source": "usbands",
                "classes": ev["classes"], "has_recap": False,
            })
            if ev.get("champ"):
                for c in ev["classes"]:
                    if c["results"] and c["class"].startswith("Group"):
                        top = c["results"][0]
                        champions.setdefault(str(year), {})[c["class"]] = {
                            "corps": top["corps"], "score": top["score"]}
        season_files[year] = season_events

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
        (DOCS_USB / "corps" / f"{sl}.json").write_text(
            json.dumps({"name": name, "performances": plist}))
        cls_now = plist[-1]["cls"]
        titles = sorted(y for y, cl in champions.items()
                        if any(v.get("corps") == name for v in cl.values()))
        profiles[sl] = {
            "title": name,
            "img": monogram(name),
            "summary": f"{name} competes in US Bands {cls_now}. "
            + (f"National class champion: {', '.join(titles)}. " if titles else "")
            + f"Scores from official USBands results, {yrs[0]}–{yrs[-1]}.",
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

    # demo files the live rebuild does not cover must not survive it — the
    # app would show fake scores next to real ones.
    for p in (DOCS_USB / "seasons").glob("*.json"):
        if p.stem.isdigit() and int(p.stem) not in years:
            p.unlink()
    live_slugs = {c["slug"] for c in idx}
    for p in (DOCS_USB / "corps").glob("*.json"):
        if p.stem not in live_slugs:
            p.unlink()

    w = lambda rel, obj: (DOCS_USB / rel).write_text(json.dumps(obj))
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
    (DOCS_USB / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"usbands: wrote {sum(len(v) for v in season_files.values())} events across {years}, "
        f"{sum(len(v['rows']) for v in standings.values())} standings rows, {len(idx)} bands")


def ingest(year: int, *, force: bool = True) -> int:
    ids = list_event_ids(year, force=force)
    if not ids:
        log(f"usbands ingest: no events found for {year}")
        return 1
    parsed_events, skipped = [], 0
    for eid in ids:
        ev = parse_event(eid, year, force=force)
        if ev:
            parsed_events.append(ev)
            log(f"  {eid}: {ev['date']} {ev['name']} — "
                f"{len(ev['classes'])} divisions, "
                f"{sum(len(c['results']) for c in ev['classes'])} rows")
        else:
            skipped += 1

    n_rows = sum(len(c["results"]) for e in parsed_events for c in e["classes"])
    bad = [r["score"] for e in parsed_events for c in e["classes"] for r in c["results"]
           if not (40.0 <= r["score"] <= 100.0)]
    if len(parsed_events) < 10 or n_rows < 200 or bad:
        log(f"usbands ingest {year}: validation FAILED ({len(parsed_events)} events, "
            f"{n_rows} rows, {len(bad)} out-of-range scores) — keeping existing data")
        return 1

    store = {"years": {}}
    if STORE.exists():
        try:
            store = json.loads(STORE.read_text())
        except Exception:  # noqa: BLE001
            pass
    store.setdefault("years", {})[str(year)] = parsed_events
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS_USB.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    log(f"usbands ingest {year}: OK — {len(parsed_events)} events, {n_rows} result rows"
        + (f"; {skipped} events without scores skipped" if skipped else ""))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--discover", action="store_true",
                    help="probe usbands.org + bridge, write data/usbands_probe.json")
    ap.add_argument("--ingest", action="store_true",
                    help="parse season scores, rebuild docs/usbands/data (validated)")
    ap.add_argument("--year", type=int, default=datetime.now().year)
    ap.add_argument("--cached", action="store_true",
                    help="dev only: reuse the on-disk fetch cache instead of refetching")
    args = ap.parse_args()
    if args.discover:
        return discover()
    if args.ingest:
        return ingest(args.year, force=not args.cached)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
