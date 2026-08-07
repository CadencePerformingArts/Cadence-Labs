#!/usr/bin/env python3
"""Generate the DCI snapshot consumed by packages/data from the Corps Central
pipeline output in docs/data/. Run from the repo root:

    python3 scripts/gen_dci_snapshot.py

The snapshot is real DCI.org data captured at a point in time — the app labels
it with its provenance and generation timestamp. Re-run whenever docs/data/
refreshes to update the in-app snapshot.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = ROOT / "packages" / "data" / "src" / "fixtures" / "dci-snapshot.json"

DIVISION_BY_CLASS = {
    "World Class": "world",
    "Open Class": "open",
    "All-Age": "allage",
    "International": "intl",
}


def slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def load_caption_totals(season: int) -> dict:
    """Parse the season's caption recaps into per-(event, corps) caption-group
    totals. Recap rows are flat score arrays laid out as, per judging group:
    each sub-caption's columns then its subtotal, then the group total; the
    array ends with [score, penalty, total]."""
    path = DATA / "recaps" / f"{season}.json"
    if not path.exists():
        return {}
    recaps = json.loads(path.read_text())
    out: dict = {}
    for ev in recaps.get("events", []):
        key_prefix = (ev.get("e", ""), ev.get("d", ""))
        for cls in ev.get("classes", []):
            for row in cls.get("rows", []):
                name, scores = row[0], row[1]
                idx = 0
                captions = []
                ok = True
                for group in cls.get("groups", []):
                    for sub in group.get("subs", []):
                        idx += len(sub.get("cols", [])) + 1
                    if idx >= len(scores):
                        ok = False
                        break
                    captions.append({"caption": group["n"], "score": scores[idx]})
                    idx += 1
                penalty = scores[idx + 1] if ok and idx + 2 < len(scores) + 1 and len(scores) >= idx + 2 else None
                if ok and captions:
                    entry = {"captions": captions}
                    if isinstance(penalty, (int, float)) and penalty:
                        entry["penalty"] = penalty
                    out[(key_prefix[0], key_prefix[1], name)] = entry
    return out


def main() -> None:
    rankings = json.loads((DATA / "rankings.json").read_text())
    season = rankings["season"]
    season_events = json.loads((DATA / "seasons" / f"{season}.json").read_text())
    upcoming = json.loads((DATA / "upcoming.json").read_text())
    champions = json.loads((DATA / "champions.json").read_text())
    records = json.loads((DATA / "records.json").read_text())
    caption_totals = load_caption_totals(season)

    generated = rankings.get("generated", "")
    fetched_at = (
        datetime.strptime(generated, "%Y-%m-%d %H:%M UTC")
        .replace(tzinfo=timezone.utc)
        .isoformat()
        if generated
        else datetime.now(timezone.utc).isoformat()
    )

    standings = {}
    ensembles = {}
    for class_name, block in rankings["standings"].items():
        division = DIVISION_BY_CLASS.get(class_name)
        if not division:
            continue
        rows = []
        for row in block["rows"]:
            eid = slug(row["corps"])
            entry = {
                "ensembleId": eid,
                "name": row["corps"],
                "divisionId": division,
                "rank": row["rank"],
                "score": row["score"],
                "delta": row.get("delta"),
                "lastEvent": row.get("event"),
                "lastDate": row.get("date"),
                "outings": row.get("outings"),
                "trend": [
                    {"date": d, "score": s} for d, s in row.get("trend", [])
                ],
            }
            # JSON null crosses into TS as null, not undefined — drop it.
            rows.append({k: v for k, v in entry.items() if v is not None})
            ensembles.setdefault(
                eid,
                {
                    "id": eid,
                    "modeId": "dci",
                    "segmentId": "dci-tour",
                    "divisionId": division,
                    "name": row["corps"],
                },
            )
        standings[division] = rows

    events = []
    for ev in season_events:
        results = []
        for cls in ev.get("classes", []):
            division = DIVISION_BY_CLASS.get(cls.get("class"))
            if not division:
                continue
            for r in cls.get("results", []):
                eid = slug(r["corps"])
                ensembles.setdefault(
                    eid,
                    {
                        "id": eid,
                        "modeId": "dci",
                        "segmentId": "dci-tour",
                        "divisionId": division,
                        "name": r["corps"],
                    },
                )
                perf = {
                    "ensembleId": eid,
                    "ensembleName": r["corps"],
                    "divisionId": division,
                    "score": r.get("score"),
                    "rank": r.get("place"),
                }
                recap = caption_totals.get((ev["name"], ev["date"], r["corps"]))
                if recap:
                    perf.update(recap)
                results.append({k: v for k, v in perf.items() if v is not None})
        if not results:
            continue
        events.append(
            {
                "id": f"{season}-{slug(ev['name'])}-{ev['date']}",
                "modeId": "dci",
                "segmentId": "dci-tour",
                "name": ev["name"],
                "date": ev["date"],
                "city": ev.get("location"),
                "sessions": [{"id": "results", "name": "Results", "order": 1, "results": results}],
                "sourceUrl": ev.get("url"),
            }
        )

    today = datetime.now(timezone.utc).date().isoformat()
    for ev in upcoming:
        if ev.get("date", "") < today:
            continue
        events.append(
            {
                "id": f"{season}-{slug(ev['name'])}-{ev['date']}-upcoming",
                "modeId": "dci",
                "segmentId": "dci-tour",
                "name": ev["name"],
                "date": ev["date"],
                "city": ev.get("location"),
                "sessions": [],
                "upcoming": True,
                "lineup": ev.get("lineup", []),
                "sourceUrl": ev.get("url"),
            }
        )

    champion_rows = []
    for year in sorted(champions, reverse=True):
        for class_name, entry in champions[year].items():
            division = DIVISION_BY_CLASS.get(class_name)
            if not division:
                continue
            champion_rows.append(
                {
                    "season": year,
                    "divisionId": division,
                    "name": entry["corps"],
                    "score": entry.get("score"),
                }
            )

    record_rows = []
    for class_name, block in records.items():
        division = DIVISION_BY_CLASS.get(class_name)
        if not division:
            continue
        for season_year, date, corps, score, event_name in block.get("top", [])[:10]:
            record_rows.append(
                {
                    "season": str(season_year),
                    "date": date,
                    "divisionId": division,
                    "name": corps,
                    "score": score,
                    "event": event_name,
                }
            )

    snapshot = {
        "season": season,
        "provenance": {
            "sourceId": "dci-org-snapshot",
            "sourceName": "DCI.org via Corps Central pipeline",
            "url": "https://www.dci.org/scores",
            "fetchedAt": fetched_at,
            "kind": "snapshot",
        },
        "standings": standings,
        "events": sorted(events, key=lambda e: e["date"], reverse=True),
        "ensembles": sorted(ensembles.values(), key=lambda e: e["name"]),
        "champions": champion_rows,
        "records": record_rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1))
    print(
        f"wrote {OUT} — {sum(len(r) for r in standings.values())} standings rows, "
        f"{len(events)} events, {len(ensembles)} ensembles, {len(champion_rows)} champions"
    )


if __name__ == "__main__":
    main()
