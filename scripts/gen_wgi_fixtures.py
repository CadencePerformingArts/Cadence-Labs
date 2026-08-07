#!/usr/bin/env python3
"""Generate the WGI demo dataset for the static WGI app (docs/wgi/data/).

WGI has no permitted live feed yet, so this is clearly-labeled DEMO data:
real, well-known ensemble names with invented scores shaped like a real WGI
season (regionals building to the World Championships in Dayton, class-
separated scoring, Prelims → Semis → Finals at Worlds).

    python3 scripts/gen_wgi_fixtures.py
"""
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "wgi" / "data"
SEASON = 2026

# activity -> class -> [(ensemble, home)]
ROSTER = {
    "guard": {
        "Independent World": [
            ("Pride of Cincinnati", "Cincinnati, OH"),
            ("Blessed Sacrament", "Newark, NJ"),
            ("Onyx", "Dayton, OH"),
            ("Paramount", "Atlanta, GA"),
            ("Imbue", "Indianapolis, IN"),
            ("Bluecoats Indoor", "Canton, OH"),
        ],
        "Independent Open": [
            ("Juxtaposition", "Rochester, NY"),
            ("Vintage", "Kettering, OH"),
            ("First Flight", "Raleigh, NC"),
            ("MCM", "San Antonio, TX"),
        ],
        "Independent A": [
            ("Veritas", "Lexington, KY"),
            ("Corona Winter Guard", "Corona, CA"),
            ("Sacred Heart", "Vineland, NJ"),
        ],
        "Scholastic World": [
            ("Avon HS", "Avon, IN"),
            ("Carmel HS", "Carmel, IN"),
            ("Tarpon Springs HS", "Tarpon Springs, FL"),
            ("Flanagan HS", "Pembroke Pines, FL"),
            ("Trumbull HS", "Trumbull, CT"),
        ],
        "Scholastic Open": [
            ("Center Grove HS", "Greenwood, IN"),
            ("James Bowie HS", "Austin, TX"),
            ("Fishers HS", "Fishers, IN"),
        ],
        "Scholastic A": [
            ("Lebanon HS", "Lebanon, OH"),
            ("Bellbrook HS", "Bellbrook, OH"),
            ("North Ridgeville HS", "North Ridgeville, OH"),
        ],
    },
    "percussion": {
        "Independent World": [
            ("Rhythm X", "Dayton, OH"),
            ("Broken City", "Riverside, CA"),
            ("Pulse Percussion", "Los Angeles, CA"),
            ("Matrix", "Akron, OH"),
            ("STRYKE Percussion", "Fort Lauderdale, FL"),
            ("United Percussion", "Cherry Hill, NJ"),
        ],
        "Independent Open": [
            ("George Mason University", "Fairfax, VA"),
            ("Vessel", "Denton, TX"),
            ("Colt Cadets Indoor", "Dubuque, IA"),
        ],
        "Scholastic World": [
            ("Ayala HS", "Chino Hills, CA"),
            ("Chino Hills HS", "Chino Hills, CA"),
            ("Dartmouth HS", "Dartmouth, MA"),
            ("Plymouth-Canton", "Canton, MI"),
        ],
        "Scholastic Open": [
            ("Mission Viejo HS", "Mission Viejo, CA"),
            ("Sparkman HS", "Harvest, AL"),
        ],
        "Scholastic Concert World": [
            ("Chino Hills Concert", "Chino Hills, CA"),
            ("Poteet Concert", "Mesquite, TX"),
        ],
    },
    "winds": {
        "Independent World": [
            ("Rhythm X Winds", "Dayton, OH"),
            ("STRYKE Wynds", "Fort Lauderdale, FL"),
            ("Cap City Winds", "Columbus, OH"),
            ("Resistance Winds", "Houston, TX"),
        ],
        "Independent Open": [
            ("Meraki Winds", "Nashville, TN"),
            ("Juniper Winds", "Boise, ID"),
        ],
        "Scholastic World": [
            ("Flanagan HS Winds", "Pembroke Pines, FL"),
            ("Bellbrook HS Winds", "Bellbrook, OH"),
            ("Union HS Winds", "Tulsa, OK"),
        ],
    },
}

# (id-suffix, name, date, city, activities present, is_worlds)
SCHEDULE = [
    ("mideast", "WGI Mid-East Power Regional", "2026-02-07", "Cincinnati, OH", ["guard", "percussion"], False),
    ("socal", "WGI SoCal Power Regional", "2026-02-21", "Riverside, CA", ["guard", "percussion"], False),
    ("tampa", "WGI Tampa Regional", "2026-02-28", "Tampa, FL", ["guard", "winds"], False),
    ("indy", "WGI Indianapolis Regional", "2026-03-14", "Indianapolis, IN", ["guard", "percussion", "winds"], False),
    ("dayton", "WGI Dayton Regional", "2026-03-28", "Dayton, OH", ["guard", "percussion", "winds"], False),
    ("worlds", "WGI World Championships", "2026-04-18", "Dayton, OH", ["guard", "percussion", "winds"], True),
]

ACTIVITY_NAMES = {"guard": "Color Guard", "percussion": "Percussion", "winds": "Winds"}

BASE = {"Independent World": 88.0, "Independent Open": 84.5, "Independent A": 82.0,
        "Scholastic World": 87.0, "Scholastic Open": 83.5, "Scholastic A": 81.0,
        "Scholastic Concert World": 85.0}


def slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def score_for(cls: str, seat: int, outing: int, n_outings: int, final_round: int = 0) -> float:
    """Deterministic, plausible growth: seeded by seat, rises over the season,
    with small crossings so standings aren't static."""
    base = BASE.get(cls, 82.0) - seat * 1.35
    growth = 7.5 * (outing / max(n_outings - 1, 1)) ** 0.85
    wiggle = ((seat * 7 + outing * 13) % 5 - 2) * 0.22
    return round(min(base + growth + wiggle + final_round * 0.9, 99.35), 3)


def main() -> None:
    activities = {}
    events = []

    # per-ensemble outing bookkeeping so trends line up with event results
    outings: dict = {}

    scored_stops = [s for s in SCHEDULE]
    for act_key, classes in ROSTER.items():
        for cls, members in classes.items():
            for seat, (name, home) in enumerate(members):
                outings[(act_key, cls, name)] = []

    for stop_i, (sid, ename, edate, ecity, acts, is_worlds) in enumerate(scored_stops):
        for act_key in acts:
            classes_here = {}
            for cls, members in ROSTER[act_key].items():
                # regionals draw a rotating subset; Worlds draws everyone
                take = members if is_worlds else [m for i, m in enumerate(members) if (i + stop_i) % 3 != 2]
                if len(take) < 2:
                    take = members
                rows = []
                for name, home in take:
                    seat = [m[0] for m in members].index(name)
                    prior = len(outings[(act_key, cls, name)])
                    sc = score_for(cls, seat, prior, 5, 0)
                    outings[(act_key, cls, name)].append({"date": edate, "event": ename, "score": sc})
                    rows.append({"ensemble": name, "home": home, "score": sc})
                rows.sort(key=lambda r: -r["score"])
                for i, r in enumerate(rows):
                    r["place"] = i + 1
                classes_here[cls] = rows
            if is_worlds:
                # Prelims (above), then Semis/Finals for World classes
                sessions = [{"name": "Prelims", "classes": classes_here}]
                for extra_i, sess_name in enumerate(["Semifinals", "Finals"], start=1):
                    sess_classes = {}
                    for cls, rows in classes_here.items():
                        if "World" not in cls:
                            continue
                        cut = rows[: max(3, len(rows) - 1)] if sess_name == "Semifinals" else rows[:4]
                        srows = []
                        for r in cut:
                            seat = [m[0] for m in ROSTER[act_key][cls]].index(r["ensemble"])
                            sc = score_for(cls, seat, 5, 5, extra_i)
                            srows.append({"ensemble": r["ensemble"], "home": r["home"], "score": sc})
                            outings[(act_key, cls, r["ensemble"])].append(
                                {"date": edate, "event": f"{ename} {sess_name}", "score": sc})
                        srows.sort(key=lambda r: -r["score"])
                        for i, r in enumerate(srows):
                            r["place"] = i + 1
                            if sess_name == "Finals" and i == 0:
                                r["award"] = f"{cls} Champion"
                        sess_classes[cls] = srows
                    sessions.append({"name": sess_name, "classes": sess_classes})
            else:
                sessions = [{"name": "Finals", "classes": classes_here}]
            events.append({
                "id": f"{SEASON}-{sid}-{act_key}",
                "activity": act_key,
                "name": ename,
                "date": edate,
                "city": ecity,
                "worlds": is_worlds,
                "sessions": sessions,
            })

    # standings: latest score per ensemble, with trend
    for act_key, classes in ROSTER.items():
        cls_block = {}
        for cls, members in classes.items():
            rows = []
            for name, home in members:
                hist = outings[(act_key, cls, name)]
                if not hist:
                    continue
                last = hist[-1]
                prev = hist[-2] if len(hist) > 1 else None
                rows.append({
                    "ensemble": name,
                    "id": slug(name),
                    "home": home,
                    "score": last["score"],
                    "delta": round(last["score"] - prev["score"], 3) if prev else None,
                    "event": last["event"],
                    "date": last["date"],
                    "outings": len(hist),
                    "trend": [[h["date"], h["score"], h["event"]] for h in hist],
                })
            rows.sort(key=lambda r: -r["score"])
            for i, r in enumerate(rows):
                r["rank"] = i + 1
            cls_block[cls] = {"rows": rows}
        activities[act_key] = {
            "name": ACTIVITY_NAMES[act_key],
            "classes": cls_block,
            "class_order": list(classes.keys()),
        }

    upcoming = [{
        "name": "WGI Mid-East Power Regional",
        "date": f"{SEASON + 1}-02-06",
        "date_display": f"February 6, {SEASON + 1}",
        "city": "Cincinnati, OH",
        "activities": ["guard", "percussion"],
    }]

    data = {
        "demo": True,
        "generated": "fixture — demo season",
        "season": SEASON,
        "activity_order": ["guard", "percussion", "winds"],
        "activities": activities,
        "events": sorted(events, key=lambda e: (e["date"], e["activity"])),
        "upcoming": upcoming,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "wgi.json").write_text(json.dumps(data, indent=1))
    n_rows = sum(len(c["rows"]) for a in activities.values() for c in a["classes"].values())
    print(f"wrote {OUT/'wgi.json'} — {n_rows} standings rows, {len(events)} event/activity blocks")


if __name__ == "__main__":
    main()
