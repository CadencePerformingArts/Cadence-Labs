#!/usr/bin/env python3
"""Build docs/data/onthisday.json — a compact "This Day in DCI History" index.

Keyed by "MM-DD" → up to 6 notable entries drawn from every season's events on
that calendar day, ranked so the biggest moments (World Championship Finals,
then highest scores) come first. Static history; regenerate when season data
changes. Reads docs/data/seasons/*.json, writes docs/data/onthisday.json."""
import json, glob, os, collections

DOCS = os.path.join(os.path.dirname(__file__), "..", "docs")
SEASONS = os.path.join(DOCS, "data", "seasons")
# NOTE: lives in docs/ (NOT docs/data/) on purpose — the scraper wipes docs/data
# on every run (build_data.py rmtree), which would delete this static index.
OUT = os.path.join(DOCS, "onthisday.json")

# marquee class priority — the class whose winner headlines the event
PRIO = {"World Class": 0, "Open Class": 1, "All-Age": 2, "International": 3}


def marquee(ev):
    best, bestp = None, 99
    for c in ev.get("classes", []):
        p = PRIO.get(c.get("class"), 50)
        if p < bestp and c.get("results"):
            best, bestp = c, p
    return best


def winner(c):
    res = [r for r in c.get("results", []) if r.get("score") is not None]
    if not res:
        return None
    res.sort(key=lambda r: (r.get("place") if r.get("place") is not None else 999))
    return res[0], len(res)


def kind(name, cls):
    n = (name or "").lower()
    title = "world championship" in n
    round_ = any(k in n for k in ["prelim", "semi", "quarter", "division ii",
                                  "division iii", "class a", "all girl"])
    if title and cls == "World Class" and not round_:
        return 3            # the night a World Class champion is crowned
    if "championship" in n or "nationals" in n:
        return 2
    return 0


def build():
    days = collections.defaultdict(list)
    for f in sorted(glob.glob(os.path.join(SEASONS, "*.json"))):
        year = int(os.path.splitext(os.path.basename(f))[0])
        for ev in json.load(open(f)):
            date = ev.get("date") or ""
            if len(date) != 10:
                continue
            mmdd = date[5:]
            c = marquee(ev)
            if not c:
                continue
            w = winner(c)
            if not w:
                continue
            row, n = w
            k = kind(ev.get("name"), c.get("class"))
            days[mmdd].append({
                "y": year, "e": ev.get("name"), "loc": ev.get("location"),
                "cls": c.get("class"), "c": row.get("corps"),
                "s": row.get("score"), "n": n, "k": k,
            })
    out = {}
    for mmdd, rows in days.items():
        # champion-crowning nights first, then highest scores
        rows.sort(key=lambda r: (-r["k"], -(r["s"] or 0)))
        # de-dupe: one entry per (year, corps) so a corps winning several
        # classes/rounds the same day doesn't crowd the list
        seen, keep = set(), []
        for r in rows:
            key = (r["y"], r["c"])
            if key in seen:
                continue
            seen.add(key)
            keep.append(r)
            if len(keep) >= 6:
                break
        out[mmdd] = keep
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote", OUT, "days:", len(out),
          "bytes:", os.path.getsize(OUT))


if __name__ == "__main__":
    build()
