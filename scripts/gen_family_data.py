#!/usr/bin/env python3
"""Generate demo datasets for every Cadence family app instance, in the exact
format the DCI pipeline publishes (docs/data/*). Each instance gets a full
data/ directory: meta, rankings, seasons, corps_index, corps/<slug>,
profiles, champions, records, db — so the shared family engine renders every
page exactly like the DCI app.

All of this is clearly-labeled DEMO data: real, well-known ensemble names
with deterministic invented scores. When a permitted live source exists for
a mode, its generator here is replaced by a real adapter writing the same
format — nothing else changes.

    python3 scripts/gen_family_data.py
"""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SEASONS = [2024, 2025, 2026]
UPDATED = "demo season — sample data"

# ---------------------------------------------------------------------------
# Instance definitions
# ---------------------------------------------------------------------------
# events: (id, name, month, day, city, worlds?) — dates realized per season.


def wgi_schedule(act_label):
    return [
        (f"WGI Mid-East Power Regional", 2, 8, "Cincinnati, OH", False),
        (f"WGI SoCal Power Regional", 2, 22, "Riverside, CA", False),
        (f"WGI Indianapolis Regional", 3, 8, "Indianapolis, IN", False),
        (f"WGI Dayton Regional", 3, 22, "Dayton, OH", False),
        (f"WGI World Championships — {act_label}", 4, 18, "Dayton, OH", True),
    ]


INSTANCES = {
    "wgi/guard": {
        "roster": {
            "Independent World": [("Pride of Cincinnati", "Cincinnati, OH"), ("Blessed Sacrament", "Newark, NJ"), ("Onyx", "Dayton, OH"), ("Paramount", "Atlanta, GA"), ("Imbue", "Indianapolis, IN"), ("Bluecoats Indoor", "Canton, OH")],
            "Independent Open": [("Juxtaposition", "Rochester, NY"), ("Vintage", "Kettering, OH"), ("First Flight", "Raleigh, NC"), ("MCM", "San Antonio, TX")],
            "Independent A": [("Veritas", "Lexington, KY"), ("Corona Winter Guard", "Corona, CA"), ("Sacred Heart", "Vineland, NJ")],
            "Scholastic World": [("Avon HS", "Avon, IN"), ("Carmel HS", "Carmel, IN"), ("Tarpon Springs HS", "Tarpon Springs, FL"), ("Flanagan HS", "Pembroke Pines, FL"), ("Trumbull HS", "Trumbull, CT")],
            "Scholastic Open": [("Center Grove HS", "Greenwood, IN"), ("James Bowie HS", "Austin, TX"), ("Fishers HS", "Fishers, IN")],
            "Scholastic A": [("Lebanon HS", "Lebanon, OH"), ("Bellbrook HS", "Bellbrook, OH"), ("North Ridgeville HS", "North Ridgeville, OH")],
        },
        "schedule": wgi_schedule("Color Guard"),
        "base": {"Independent World": 88.0, "Independent Open": 84.5, "Independent A": 82.0, "Scholastic World": 87.0, "Scholastic Open": 83.5, "Scholastic A": 81.0},
    },
    "wgi/percussion": {
        "roster": {
            "Independent World": [("Rhythm X", "Dayton, OH"), ("Broken City", "Riverside, CA"), ("Pulse Percussion", "Los Angeles, CA"), ("Matrix", "Akron, OH"), ("STRYKE Percussion", "Fort Lauderdale, FL"), ("United Percussion", "Cherry Hill, NJ")],
            "Independent Open": [("George Mason University", "Fairfax, VA"), ("Vessel", "Denton, TX"), ("Colt Cadets Indoor", "Dubuque, IA")],
            "Scholastic World": [("Ayala HS", "Chino Hills, CA"), ("Chino Hills HS", "Chino Hills, CA"), ("Dartmouth HS", "Dartmouth, MA"), ("Plymouth-Canton", "Canton, MI")],
            "Scholastic Open": [("Mission Viejo HS", "Mission Viejo, CA"), ("Sparkman HS", "Harvest, AL")],
            "Scholastic Concert World": [("Chino Hills Concert", "Chino Hills, CA"), ("Poteet Concert", "Mesquite, TX")],
        },
        "schedule": wgi_schedule("Percussion"),
        "base": {"Independent World": 88.5, "Independent Open": 84.0, "Scholastic World": 87.5, "Scholastic Open": 83.0, "Scholastic Concert World": 85.0},
    },
    "wgi/winds": {
        "roster": {
            "Independent World": [("Rhythm X Winds", "Dayton, OH"), ("STRYKE Wynds", "Fort Lauderdale, FL"), ("Cap City Winds", "Columbus, OH"), ("Resistance Winds", "Houston, TX")],
            "Independent Open": [("Meraki Winds", "Nashville, TN"), ("Juniper Winds", "Boise, ID")],
            "Scholastic World": [("Flanagan HS Winds", "Pembroke Pines, FL"), ("Bellbrook HS Winds", "Bellbrook, OH"), ("Union HS Winds", "Tulsa, OK")],
        },
        "schedule": wgi_schedule("Winds"),
        "base": {"Independent World": 87.5, "Independent Open": 83.5, "Scholastic World": 86.0},
    },
    "boa": {
        "roster": {
            "Class AAAA": [("Carmel HS", "Carmel, IN"), ("Avon HS", "Avon, IN"), ("Broken Arrow HS", "Broken Arrow, OK"), ("Hebron HS", "Carrollton, TX"), ("Flower Mound HS", "Flower Mound, TX"), ("Vandegrift HS", "Austin, TX"), ("Blue Springs HS", "Blue Springs, MO"), ("Bentonville HS", "Bentonville, AR")],
            "Class AAA": [("Marian Catholic HS", "Chicago Heights, IL"), ("Claudia Taylor Johnson HS", "San Antonio, TX"), ("Rockford HS", "Rockford, MI"), ("Owasso HS", "Owasso, OK")],
            "Class AA": [("Union HS", "Tulsa, OK"), ("Bourbon County HS", "Paris, KY"), ("Wando HS", "Mount Pleasant, SC")],
            "Class A": [("Adair County HS", "Columbia, KY"), ("Western Carteret HS", "Cape Carteret, NC")],
        },
        "schedule": [
            ("BOA St. George Regional", 9, 26, "St. George, UT", False),
            ("BOA Obetz Regional", 10, 3, "Obetz, OH", False),
            ("BOA San Antonio Super Regional", 10, 24, "San Antonio, TX", False),
            ("BOA Indianapolis Super Regional", 10, 31, "Indianapolis, IN", False),
            ("Grand National Championships", 11, 14, "Indianapolis, IN", True),
        ],
        "base": {"Class AAAA": 88.0, "Class AAA": 85.5, "Class AA": 83.0, "Class A": 81.0},
        "note": "Every BOA championship has its own judging panel — scores compare within an event, and season standings show each band's most recent score.",
    },
    "acappella": {
        "roster": {
            "ICCA": [("The SoCal VoCals", "University of Southern California"), ("The Nor'easters", "Northeastern University"), ("Pitch Slapped", "Berklee College of Music"), ("Voices in Your Head", "University of Chicago"), ("Fundamentally Sound", "University of Wisconsin"), ("The Melodores", "Vanderbilt University"), ("Vocal Point", "Brigham Young University"), ("The Hullabahoos", "University of Virginia")],
            "ICHSA": [("Forte", "Centerville HS"), ("Limited Edition", "Homestead HS"), ("Vocal Fusion", "Millburn HS"), ("Highland Voices", "Highland Park HS")],
        },
        "schedule": [
            ("ICCA & ICHSA Quarterfinals — Northeast", 2, 7, "Boston, MA", False),
            ("ICCA & ICHSA Quarterfinals — West", 2, 21, "Los Angeles, CA", False),
            ("ICCA & ICHSA Semifinals — Midwest", 3, 21, "Chicago, IL", False),
            ("ICCA & ICHSA Semifinals — Northeast", 3, 28, "New York, NY", False),
            ("Varsity Vocals Finals", 4, 25, "New York, NY", True),
        ],
        "base": {"ICCA": 88.0, "ICHSA": 84.0},
        "note": "Varsity Vocals is a bracketed tournament — points rank groups within one round of one event; standings show each group's most recent judged score.",
    },
    "showchoir": {
        "roster": {
            "Mixed": [('John Burroughs "Powerhouse"', "Burbank, CA"), ('Carmel "Ambassadors"', "Carmel, IN"), ('Waubonsie Valley "Sound Check"', "Aurora, IL"), ('Los Alamitos "Sound FX"', "Los Alamitos, CA"), ('Clinton "Attaché"', "Clinton, MS")],
            "Treble": [('Carmel "Accents"', "Carmel, IN"), ('John Burroughs "Sound Sensations"', "Burbank, CA"), ('Los Alamitos "Sound Trax"', "Los Alamitos, CA")],
            "Small School": [('Petal "Innovations"', "Petal, MS"), ('Sartell "Chain Reaction"', "Sartell, MN")],
            "Large School": [('Totino-Grace "Company of Singers"', "Fridley, MN"), ('Wheaton Warrenville South "Esprit"', "Wheaton, IL")],
        },
        "schedule": [
            ("Heart of America Show Choir Classic", 1, 24, "Kansas City, MO", False),
            ("Mid-Winter Show Choir Invitational", 2, 7, "Nashville, TN", False),
            ("FAME Chicago National Championship", 3, 14, "Chicago, IL", False),
            ("Show Choir Nationals", 4, 11, "Nashville, TN", True),
        ],
        "base": {"Mixed": 88.5, "Treble": 86.0, "Small School": 85.0, "Large School": 86.5},
        "note": "Show choir invitationals each define their own judging — scores compare within an event; standings show each choir's most recent score.",
    },
}


def slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def jitter(*parts, mod=100) -> int:
    h = hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:8], 16) % mod


def score_for(base, seat, outing, n_outings, year, name, worlds_round=0):
    growth = 8.2 * (outing / max(n_outings - 1, 1)) ** 0.85
    season_shift = (jitter(name, year, "season") - 50) / 55.0
    wiggle = (jitter(name, year, outing) - 50) / 38.0
    s = base - seat * 1.32 + growth + season_shift + wiggle + worlds_round * 0.85
    return round(min(s, 99.4), 3)


def gen_instance(key, cfg):
    out = DOCS / key / "data"
    (out / "seasons").mkdir(parents=True, exist_ok=True)
    (out / "corps").mkdir(exist_ok=True)
    (out / "db").mkdir(exist_ok=True)

    roster = cfg["roster"]
    classes = list(roster.keys())
    perfs = {}          # (cls, name) -> [{y,d,ev,p,s}]
    season_files = {}
    champions = {}
    all_db_rows = []

    for year in SEASONS:
        events = []
        outings = {(c, n): 0 for c in classes for n, _ in roster[c]}
        for ev_i, (ename, month, day, city, worlds) in enumerate(cfg["schedule"]):
            date = f"{year}-{month:02d}-{day:02d}"
            ev_classes = []
            for cls in classes:
                members = roster[cls]
                take = members if worlds else [m for i, m in enumerate(members) if (i + ev_i + year) % 3 != 2]
                if len(take) < 2:
                    take = members
                rows = []
                for name, _home in take:
                    seat = [m[0] for m in members].index(name)
                    o = outings[(cls, name)]
                    s = score_for(cfg["base"][cls], seat, o, len(cfg["schedule"]), year, name,
                                  1 if worlds else 0)
                    outings[(cls, name)] += 1
                    rows.append({"corps": name, "score": s})
                rows.sort(key=lambda r: -r["score"])
                results = [{"place": i + 1, "corps": r["corps"], "score": r["score"]}
                           for i, r in enumerate(rows)]
                ev_classes.append({"class": cls, "results": results})
                for r in results:
                    perfs.setdefault((cls, r["corps"]), []).append(
                        {"y": year, "d": date, "ev": ename, "cls": cls, "p": r["place"], "s": r["score"]})
                    all_db_rows.append([year, date, ename, r["corps"], cls, r["place"], r["score"]])
                if worlds:
                    champions.setdefault(str(year), {})[cls] = {
                        "corps": results[0]["corps"], "score": results[0]["score"]}
            events.append({
                "name": ename, "date": date,
                "date_display": f"{['','January','February','March','April','May','June','July','August','September','October','November','December'][month]} {day}, {year}",
                "location": city, "url": None, "source": "demo",
                "classes": ev_classes, "has_recap": False,
            })
        season_files[year] = events

    # rankings from the latest season
    latest = SEASONS[-1]
    standings = {}
    for cls in classes:
        rows = []
        for name, home in roster[cls]:
            hist = [p for p in perfs.get((cls, name), []) if p["y"] == latest]
            if not hist:
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
        standings[cls] = {"rows": rows}

    recent = []
    for ev in reversed(season_files[latest][-3:]):
        top = ev["classes"][0]["results"][0]
        recent.append({"name": ev["name"], "date": ev["date"], "location": ev["location"],
                       "winner": {"corps": top["corps"], "score": top["score"], "class": ev["classes"][0]["class"]}})

    # corps index + per-corps files + profiles
    idx, profiles = [], {}
    for cls in classes:
        for name, home in roster[cls]:
            sl = slug(name)
            plist = sorted(perfs.get((cls, name), []), key=lambda p: (p["y"], p["d"] or ""))
            series = []
            for year in SEASONS:
                ys = [p for p in plist if p["y"] == year]
                series.append([year, max((p["s"] for p in ys), default=None),
                               cls if ys else None])
            best = max((p["s"] for p in plist), default=None)
            idx.append({"name": name, "slug": sl, "first": SEASONS[0], "last": SEASONS[-1],
                        "seasons": len(SEASONS), "best": best, "n": len(plist), "series": series})
            (DOCS / key / "data" / "corps" / f"{sl}.json").write_text(
                json.dumps({"name": name, "performances": plist}))
            titles = [y for y, cl in champions.items() if cl.get(cls, {}).get("corps") == name]
            profiles[sl] = {
                "title": name,
                "summary": f"{name} ({home}) competes in {cls}. "
                + (f"Demo-season champion: {', '.join(sorted(titles))}. " if titles else "")
                + "This is demonstration data — scores are invented; the name belongs to a real, well-loved program.",
            }
    idx.sort(key=lambda c: c["name"])

    records = {}
    for cls in classes:
        flat = [(n, p) for (c, n), pl in perfs.items() if c == cls for p in pl]
        top = sorted(flat, key=lambda np: -np[1]["s"])[:10]
        finals = {}
        for year in SEASONS:
            worlds_name = cfg["schedule"][-1][0]
            rows = sorted(
                ((n, p["s"]) for n, p in flat if p["y"] == year and p["ev"] == worlds_name),
                key=lambda r: -r[1])
            if rows:
                finals[str(year)] = [[n, s] for n, s in rows]
        records[cls] = {
            "top": [[p["y"], p["d"], n, p["s"], p["ev"]] for n, p in top],
            "finals": finals,
        }

    write = lambda rel, obj: (out / rel).write_text(json.dumps(obj))
    write("meta.json", {"updated": UPDATED, "seasons": [{"year": y, "events": len(season_files[y])} for y in SEASONS]})
    write("rankings.json", {"generated": UPDATED, "season": latest, "standings": standings, "recent_events": recent})
    for y in SEASONS:
        write(f"seasons/{y}.json", season_files[y])
    write("upcoming.json", [])
    write("corps_index.json", idx)
    write("profiles.json", profiles)
    write("champions.json", champions)
    write("records.json", records)
    write("db/index.json", [{"decade": "2020s", "rows": len(all_db_rows)}])
    write("db/perfs_2020s.json", sorted(all_db_rows, key=lambda r: (r[0], r[1])))
    n_rows = sum(len(v["rows"]) for v in standings.values())
    print(f"{key}: {n_rows} standings rows · {sum(len(v) for v in season_files.values())} events · {len(idx)} ensembles")


def main():
    for key, cfg in INSTANCES.items():
        gen_instance(key, cfg)


if __name__ == "__main__":
    main()
