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


def main() -> None:
    rankings = json.loads((DATA / "rankings.json").read_text())
    season = rankings["season"]
    season_events = json.loads((DATA / "seasons" / f"{season}.json").read_text())
    upcoming = json.loads((DATA / "upcoming.json").read_text())
    champions = json.loads((DATA / "champions.json").read_text())

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
                results.append(
                    {
                        "ensembleId": eid,
                        "ensembleName": r["corps"],
                        "divisionId": division,
                        "score": r.get("score"),
                        "rank": r.get("place"),
                    }
                )
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
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1))
    print(
        f"wrote {OUT} — {sum(len(r) for r in standings.values())} standings rows, "
        f"{len(events)} events, {len(ensembles)} ensembles, {len(champion_rows)} champions"
    )


if __name__ == "__main__":
    main()
