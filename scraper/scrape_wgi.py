#!/usr/bin/env python3
"""WGI live ingest via CompetitionSuite's public bridge API — the same
platform (and largely the same code path) the DCI scraper already uses.

Two modes:

  --discover           find WGI's organization GUID and list its seasons and
                       competitions; writes data/wgi_probe.json and never
                       touches docs/. Run this first from GitHub Actions
                       (CompetitionSuite is not reachable from every network).
  --ingest --year Y    pull season Y: every competition -> rounds -> judge
                       recaps, classify classes into guard/percussion/winds,
                       and write full app datasets into docs/wgi/<activity>/data/
                       — but ONLY if validation passes. On success a LIVE
                       marker file is written, which stops the demo-data
                       generator from overwriting real results.

Honesty & care: requests go through the shared rate-limited fetch() cache;
nothing here bypasses authentication or bot protection — the bridge API and
recap pages are the public score-publishing surface WGI itself links to.
A failed or partial scrape never erases previously published data.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import ROOT, fetch, log, slugify
import scrape_compsuite as cs

DOCS_WGI = ROOT / "docs" / "wgi"
PROBE_OUT = ROOT / "data" / "wgi_probe.json"
GUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

ACTIVITIES = ("guard", "percussion", "winds")


# ---------------------------------------------------------------------------
# organization discovery
# ---------------------------------------------------------------------------

def discover_org_guid() -> str | None:
    """WGI's CompetitionSuite organization GUID, from env or wgi.org pages."""
    import os
    if os.environ.get("WGI_ORG_GUID"):
        return os.environ["WGI_ORG_GUID"]
    pages = [
        "https://wgi.org/scores/",
        "https://wgi.org/color-guard/cg-scores/",
        "https://wgi.org/percussion/perc-scores/",
        "https://wgi.org/winds/winds-scores/",
    ]
    for url in pages:
        html = fetch(url) or ""
        # look for an org GUID near any competitionsuite reference
        for m in re.finditer(r"competitionsuite[^\"'<>]{0,200}", html, re.I):
            g = GUID_RE.search(m.group(0))
            if g:
                return g.group(0)
        # fallback: any organization=<guid> parameter on the page
        m = re.search(r"organization=([0-9a-f-]{36})", html, re.I)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# activity + class handling
# ---------------------------------------------------------------------------

def classify_activity(class_name: str, competition_name: str = "") -> str:
    """Map a CompetitionSuite class label to a Cadence WGI activity."""
    s = f"{class_name} {competition_name}".lower()
    if "percussion" in s or re.search(r"\bp[si][waо]\b", s) or "concert" in s:
        return "percussion"
    if "winds" in s or re.search(r"\bw[si][wao]\b", s):
        return "winds"
    return "guard"


def norm_class(class_name: str) -> str:
    """Normalize source class labels to Cadence's display names."""
    c = re.sub(r"\s+", " ", class_name).strip()
    c = re.sub(r"^(Percussion|Winds|Color Guard|Guard)\s+", "", c, flags=re.I)
    c = re.sub(r"\s*Class$", "", c, flags=re.I)
    return c


# ---------------------------------------------------------------------------
# dataset assembly (docs/wgi/<activity>/data in the shared pipeline format)
# ---------------------------------------------------------------------------

def assemble(activity: str, year: int, events: list[dict], updated: str) -> None:
    """events: [{name, date, city, classes: {cls: [(name, score), ...]}}] with
    results already ranked (descending score)."""
    out = DOCS_WGI / activity / "data"
    (out / "seasons").mkdir(parents=True, exist_ok=True)
    (out / "corps").mkdir(exist_ok=True)
    (out / "db").mkdir(exist_ok=True)

    perfs: dict[tuple[str, str], list[dict]] = {}
    season_events = []
    db_rows = []
    for ev in sorted(events, key=lambda e: e["date"]):
        classes_out = []
        for cls, rows in ev["classes"].items():
            results = [{"place": i + 1, "corps": n, "score": s} for i, (n, s) in enumerate(rows)]
            classes_out.append({"class": cls, "results": results})
            for r in results:
                perfs.setdefault((cls, r["corps"]), []).append(
                    {"y": year, "d": ev["date"], "ev": ev["name"], "cls": cls,
                     "p": r["place"], "s": r["score"]})
                db_rows.append([year, ev["date"], ev["name"], r["corps"], cls, r["place"], r["score"]])
        season_events.append({
            "name": ev["name"], "date": ev["date"],
            "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
            "location": ev.get("city"), "url": ev.get("url"), "source": "competitionsuite",
            "classes": classes_out, "has_recap": False,
        })

    standings = {}
    classes = sorted({cls for cls, _ in perfs})
    for cls in classes:
        rows = []
        for (c, name), hist in perfs.items():
            if c != cls:
                continue
            hist.sort(key=lambda p: p["d"])
            last, prev = hist[-1], (hist[-2] if len(hist) > 1 else None)
            best = max(hist, key=lambda p: p["s"])
            rows.append({
                "corps": name, "score": last["s"], "date": last["d"], "event": last["ev"],
                "high": best["s"], "high_event": best["ev"], "high_date": best["d"],
                "prev_score": prev["s"] if prev else None,
                "delta": round(last["s"] - prev["s"], 3) if prev else None,
                "outings": len(hist),
                "trend": [[p["d"], p["s"]] for p in hist],
            })
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

    idx, profiles = [], {}
    for cls in classes:
        for (c, name), plist in perfs.items():
            if c != cls:
                continue
            sl = slugify(name)
            best = max(p["s"] for p in plist)
            idx.append({"name": name, "slug": sl, "first": year, "last": year, "seasons": 1,
                        "best": best, "n": len(plist),
                        "series": [[year, best, cls]]})
            (out / "corps" / f"{sl}.json").write_text(json.dumps({"name": name, "performances": plist}))
            profiles[sl] = {"title": name, "summary": f"{name} competes in {cls} ({activity})."}
    idx.sort(key=lambda cbox: cbox["name"])

    finals_name_frag = "world championships"
    champions, records = {}, {}
    for cls in classes:
        flat = [(n, p) for (c, n), pl in perfs.items() if c == cls for p in pl]
        worlds = [t for t in flat if finals_name_frag in t[1]["ev"].lower()]
        if worlds:
            n, p = max(worlds, key=lambda t: t[1]["s"])
            champions.setdefault(str(year), {})[cls] = {"corps": n, "score": p["s"]}
        top = sorted(flat, key=lambda t: -t[1]["s"])[:10]
        finals_rows = sorted(((n, p["s"]) for n, p in worlds), key=lambda r: -r[1])
        records[cls] = {"top": [[p["y"], p["d"], n, p["s"], p["ev"]] for n, p in top],
                        "finals": ({str(year): [[n, s] for n, s in finals_rows]} if finals_rows else {})}

    w = lambda rel, obj: (out / rel).write_text(json.dumps(obj))
    w("meta.json", {"updated": updated, "seasons": [{"year": year, "events": len(season_events)}]})
    w("rankings.json", {"generated": updated, "season": year, "standings": standings,
                        "recent_events": []})
    w(f"seasons/{year}.json", season_events)
    w("upcoming.json", [])
    w("corps_index.json", idx)
    w("profiles.json", profiles)
    w("champions.json", champions)
    w("records.json", records)
    w("db/index.json", [{"decade": "2020s", "rows": len(db_rows)}])
    w("db/perfs_2020s.json", sorted(db_rows, key=lambda r: (r[0], r[1])))
    (out / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"wgi/{activity}: wrote {len(season_events)} events, "
        f"{sum(len(v['rows']) for v in standings.values())} standings rows")


# ---------------------------------------------------------------------------
# modes
# ---------------------------------------------------------------------------

def harvest_candidates() -> tuple[list[str], dict]:
    """All GUIDs seen on wgi.org score surfaces plus one hop of score-ish
    links — candidates to test against the bridge API."""
    pages = [
        "https://wgi.org/", "https://wgi.org/scores/", "https://wgi.org/events/",
        "https://wgi.org/color-guard/", "https://wgi.org/percussion/", "https://wgi.org/winds/",
    ]
    seen, evidence = [], {}
    hop = []
    for url in pages:
        html = fetch(url) or ""
        evidence[url] = {"bytes": len(html), "guids": sorted(set(GUID_RE.findall(html)))}
        seen += evidence[url]["guids"]
        for m in re.finditer(r'href="(https?://[^"]*(?:score|recap|event|competitionsuite)[^"]*)"', html, re.I):
            if len(hop) < 12 and m.group(1) not in hop:
                hop.append(m.group(1))
    for url in hop:
        html = fetch(url) or ""
        g = sorted(set(GUID_RE.findall(html)))
        if g:
            evidence[url] = {"bytes": len(html), "guids": g}
            seen += g
    ordered = list(dict.fromkeys(seen))
    return ordered, evidence


def discover(year: int) -> int:
    org = discover_org_guid()
    report: dict = {"org_guid": org, "probed_at": datetime.now(timezone.utc).isoformat()}
    if not org:
        candidates, evidence = harvest_candidates()
        report["candidates_tested"] = candidates[:15]
        report["evidence"] = evidence
        for guid in candidates[:15]:
            seasons = cs._bridge(f"GetSeasons/jsonp?organization={guid}") or []
            if seasons:
                org = guid
                report["org_guid"] = org
                report["org_guid_via"] = "bridge-tested candidate"
                break
    if org:
        seasons = cs._bridge(f"GetSeasons/jsonp?organization={org}") or []
        report["seasons"] = seasons
        target = next((s for s in seasons if str(year) in str(s.get("name", ""))), None)
        if target:
            comps = cs._bridge(f"GetCompetitionsBySeason/jsonp?season={target.get('seasonGuid')}") or {}
            comp_list = comps.get("competitions", comps if isinstance(comps, list) else [])
            report["competitions"] = comp_list[:80]
            if comp_list:
                first = comp_list[0]
                report["first_competition_detail"] = cs._bridge(
                    f"GetCompetition/jsonp?competition={first.get('competitionGuid')}")
    PROBE_OUT.parent.mkdir(parents=True, exist_ok=True)
    PROBE_OUT.write_text(json.dumps(report, indent=1, default=str))
    ok = bool(org and report.get("seasons"))
    log(f"wgi discover: org={org or 'NOT FOUND'} seasons={len(report.get('seasons', []) or [])} "
        f"competitions={len(report.get('competitions', []) or [])} -> {PROBE_OUT}")
    return 0 if ok else 1


def ingest(year: int) -> int:
    org = discover_org_guid()
    if not org:
        log("wgi ingest: organization GUID not found — run --discover and check the probe report")
        return 1
    seasons = cs._bridge(f"GetSeasons/jsonp?organization={org}") or []
    target = next((s for s in seasons if str(year) in str(s.get("name", ""))), None)
    if not target:
        log(f"wgi ingest: no season matching {year}")
        return 1
    comps_raw = cs._bridge(f"GetCompetitionsBySeason/jsonp?season={target.get('seasonGuid')}") or {}
    comp_list = comps_raw.get("competitions", comps_raw if isinstance(comps_raw, list) else [])
    events_by_activity: dict[str, list[dict]] = {a: [] for a in ACTIVITIES}
    for comp in comp_list:
        guid = comp.get("competitionGuid")
        detail = cs._bridge(f"GetCompetition/jsonp?competition={guid}") if guid else None
        if not detail:
            continue
        date = str(comp.get("competitionDate", comp.get("date", "")))[:10]
        name = comp.get("competitionName", comp.get("name", "Unknown event"))
        city = comp.get("location") or comp.get("city")
        per_activity_classes: dict[str, dict] = {a: {} for a in ACTIVITIES}
        # _round_classes reads scores straight from the API's round
        # performances; for WGI, round names are the class names.
        classes_list, _recaps = cs._round_classes(detail)
        for cls_entry in classes_list:
            cls_name = str(cls_entry.get("class") or "Results")
            rows = []
            for r in cls_entry.get("results", []):
                try:
                    score = round(float(r["score"]), 3)
                except (KeyError, TypeError, ValueError):
                    continue
                if r.get("corps") and 0 < score <= 105:
                    rows.append((r["corps"], score))
            if len(rows) < 2:
                continue
            rows.sort(key=lambda r: -r[1])
            act = classify_activity(cls_name, name)
            label = norm_class(cls_name)
            # keep the best-scoring round per class (finals over prelims)
            prev = per_activity_classes[act].get(label)
            if not prev or max(s for _, s in rows) >= max(s for _, s in prev):
                per_activity_classes[act][label] = rows
        for act, cls_map in per_activity_classes.items():
            if cls_map:
                events_by_activity[act].append(
                    {"name": name, "date": date, "city": city, "classes": cls_map})

    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    wrote = 0
    for act, events in events_by_activity.items():
        scored = [e for e in events if e["classes"] and re.match(r"\d{4}-\d{2}-\d{2}", e["date"] or "")]
        n_rows = sum(len(r) for e in scored for r in e["classes"].values())
        if len(scored) < 3 or n_rows < 20:
            log(f"wgi/{act}: validation failed ({len(scored)} events, {n_rows} rows) — keeping existing data")
            continue
        assemble(act, year, scored, updated)
        wrote += 1
    return 0 if wrote else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--ingest", action="store_true")
    ap.add_argument("--year", type=int, default=2026)
    args = ap.parse_args()
    if args.discover:
        return discover(args.year)
    if args.ingest:
        return ingest(args.year)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
