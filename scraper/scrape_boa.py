#!/usr/bin/env python3
"""BOA (Bands of America) live ingest from the official recap PDFs that
Music for All publishes on marching.musicforall.org.

Source design (verified):
  https://marching.musicforall.org/result/            paginated list of events
  https://marching.musicforall.org/result/<slug>/     one event, links official
                                                      recap PDFs (Prelims /
                                                      Semi-Finals / Finals)

Two modes, modeled on scrape_wgi.py:

  --discover           crawl the results index, list every event and the recap
                       PDFs it links; writes data/boa_probe2.json and never
                       touches docs/.
  --ingest --year Y    parse season Y's recap PDFs with pdfplumber into
                       per-band rows (name, class A..AAAA, captions, total,
                       placement, per round), then rebuild the full app
                       dataset in docs/boa/data/ — but ONLY if validation
                       passes (>=2 events, >=30 rows, scores 40..100). On
                       success a LIVE marker stops the demo generator from
                       overwriting real results. Multi-year: each ingested
                       season is kept in a store file and every run rebuilds
                       seasons/<year>.json, corps series, records etc. across
                       all ingested years.

Honesty & care: HTML goes through the shared rate-limited fetch() cache; PDFs
are fetched by a binary twin of the same polite pattern (shared rate limiter,
on-disk cache, retries with backoff). Nothing here bypasses authentication or
bot protection — these are the public score-publishing pages BOA itself links
to. A failed or partial scrape never erases previously published data; rows
whose scores don't reconcile (subtotal + penalty != total) are dropped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

import common
from common import ROOT, fetch, log, norm_space, slugify

BASE = "https://marching.musicforall.org"
DOCS_BOA = ROOT / "docs" / "boa" / "data"
PROBE_OUT = ROOT / "data" / "boa_probe2.json"
STORE = DOCS_BOA / "live_store.json"
PDF_CACHE = ROOT / "data" / "raw" / "boa_pdf"

# BOA recaps label bands 1A/2A/3A/4A (older material sometimes A/AA/AAA/AAAA);
# map both spellings onto the app's class names (docs/boa class_order in
# scripts/gen_family_pages.py: Class AAAA .. Class A).
CLASS_MAP = {
    "1A": "Class A", "2A": "Class AA", "3A": "Class AAA", "4A": "Class AAAA",
    "A": "Class A", "AA": "Class AA", "AAA": "Class AAA", "AAAA": "Class AAAA",
}
CLASS_ORDER = ["Class AAAA", "Class AAA", "Class AA", "Class A"]
ROUNDS = ["Prelims", "Semifinals", "Finals"]  # chronological order


# ---------------------------------------------------------------------------
# binary (PDF) fetching — common.fetch() is text-only, so this is its binary
# twin: same rate limiter, same on-disk cache idea, same retry/backoff shape.
# ---------------------------------------------------------------------------

def _pdf_cache_path(url: str) -> Path:
    p = urlparse(url)
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", p.path.strip("/"))[-120:]
    return PDF_CACHE / f"{slug}_{hashlib.sha1(url.encode()).hexdigest()[:10]}.pdf"


def fetch_pdf(url: str, *, timeout: int = 90, retries: int = 3) -> Path | None:
    """Download a PDF politely (shared rate limit, cached). Returns the local
    path, or None on hard failure. Recap PDFs are immutable once published,
    so the cache never needs busting."""
    cp = _pdf_cache_path(url)
    if cp.exists() and cp.stat().st_size > 1024:
        return cp
    cp.parent.mkdir(parents=True, exist_ok=True)
    delay = 5.0
    for attempt in range(retries):
        wait = common.RATE_LIMIT_SECONDS - (time.time() - common._last_fetch[0])
        if wait > 0:
            time.sleep(wait)
        common._last_fetch[0] = time.time()
        tmp = cp.with_suffix(".part")
        try:
            r = subprocess.run(
                ["curl", "-sS", "-L", "--max-time", str(timeout),
                 "-o", str(tmp), "-w", "%{http_code}", url],
                capture_output=True, text=True, timeout=timeout + 20)
            code = int(r.stdout.strip() or 0)
            if code == 404:
                log(f"404 {url}")
                return None
            if code == 200 and tmp.exists() and tmp.read_bytes()[:5] == b"%PDF-":
                tmp.rename(cp)
                return cp
            raise RuntimeError(f"HTTP {code} or not a PDF")
        except Exception as e:  # noqa: BLE001
            log(f"pdf fetch attempt {attempt + 1}/{retries} failed: {url}: {e}")
            time.sleep(delay)
            delay *= 2
        finally:
            tmp.unlink(missing_ok=True)
    return None


# ---------------------------------------------------------------------------
# event discovery (results index -> event pages -> recap PDF links)
# ---------------------------------------------------------------------------

EVENT_URL_RE = re.compile(r'href="(https://marching\.musicforall\.org/result/([a-z0-9-]+)/)"')
PDF_URL_RE = re.compile(r'href="(https?://[^"]+\.pdf)"', re.I)
TITLE_RE = re.compile(r'<h1 class="entry-title">([^<]+)</h1>')


def event_year(slug: str) -> int | None:
    m = re.search(r"-(20\d{2})(?:-\d+)?$", slug)
    return int(m.group(1)) if m else None


def list_events(max_pages: int = 8, *, force: bool = True) -> list[dict]:
    """All events on the paginated results index: [{url, slug, year}]."""
    seen: dict[str, dict] = {}
    for page in range(1, max_pages + 1):
        url = f"{BASE}/result/" if page == 1 else f"{BASE}/result/page/{page}/"
        html = fetch(url, force=force) or ""
        found = 0
        for ev_url, slug in EVENT_URL_RE.findall(html):
            if slug in ("feed",) or slug.startswith("page"):
                continue
            if slug not in seen:
                seen[slug] = {"url": ev_url, "slug": slug, "year": event_year(slug)}
                found += 1
        if not html or (page > 1 and found == 0):
            break
    return list(seen.values())


def round_guess(href: str) -> str:
    """Round from the PDF filename; the PDF's own header wins later."""
    f = href.rsplit("/", 1)[-1].lower()
    if "semi" in f:
        return "Semifinals"
    if "prelim" in f:
        return "Prelims"
    if "final" in f:
        return "Finals"
    return "Finals"


def event_pdfs(ev: dict, *, force: bool = True) -> dict:
    """Fetch one event page; return {title, pdfs:[{href, round_guess}]}."""
    html = fetch(ev["url"], force=force) or ""
    title = None
    m = TITLE_RE.search(html)
    if m:
        title = norm_space(m.group(1))
    pdfs = []
    for href in dict.fromkeys(PDF_URL_RE.findall(html)):
        # results PDFs are not consistently named "recap" (e.g.
        # SATX-Finals-Saturday.pdf, NorthTexasPrelims.pdf) — accept any
        # round-ish name; the row parser validates the content anyway.
        if re.search(r"recap|prelim|semi|final", href.lower()):
            pdfs.append({"href": href, "round_guess": round_guess(href)})
    return {"title": title, "pdfs": pdfs}


# ---------------------------------------------------------------------------
# recap PDF parsing
# ---------------------------------------------------------------------------

DATE_RE = re.compile(r"(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})")
# "[ \t]" (not \s) so the standalone "Bands of America" / "Print Back to Top"
# header lines can never satisfy this across a newline.
EVENT_NAME_RE = re.compile(r"^Bands of America[ \t]+(\S.{3,}?)(?:,\s*presented by.*)?\s*$", re.M)
# Older recap layout: "2025 Arizona Regional Championship at Flagstaff, AZ"
ALT_NAME_RE = re.compile(r"^(20\d{2})\s+(.{4,}?)(?:\s+at\s+.+)?\s*$")
ALT_DATE_RE = re.compile(r"^(.*\S)\s+-\s+([A-Z][a-z]+\s+\d{1,2})\s*$")
ROUND_RE = re.compile(r"^\s*(Prelims|Preliminaries|Semi-?\s?Finals?|Semifinals|Finals)\s*$", re.M | re.I)
# One scored band per line:  [order-no] <name> - <ST> [Block X - Panel N]
#   <floats...> then a tail of  [rating I..III] [class-rank class] overall-rank
ROW_RE = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){4,})\s+"
    r"(?:(?P<rating>I{1,3})\s+)?"
    r"(?:(?P<crank>\d{1,3})\s+(?P<cls>[1-4]A|A{1,4})\s+)?"
    r"(?P<orank>\d{1,3})\s*$")
BLOCK_RE = re.compile(r"\s+Block\s+\S+\s+-\s+Panel\s+\d+$", re.I)
ORDER_RE = re.compile(r"^\d{1,3}\s+(?=\S)")
NAME_ST_RE = re.compile(r"^(.*\S)\s*(?:\s+-\s+|,\s+)([A-Z]{2})$")


def norm_round(label: str) -> str:
    s = label.lower()
    if "semi" in s:
        return "Semifinals"
    if "prelim" in s:
        return "Prelims"
    return "Finals"


def parse_recap(pdf_path: Path) -> dict | None:
    """Parse one recap PDF -> {name, venue, date, round, rows:[...]}.
    Rows that don't reconcile (subtotal + penalty != total, or total outside
    40..100) are dropped and logged."""
    import pdfplumber
    try:
        with pdfplumber.open(pdf_path) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception as e:  # noqa: BLE001
        log(f"unreadable pdf {pdf_path.name}: {e}")
        return None
    if len(text) < 200:
        log(f"no text layer in {pdf_path.name} — skipping")
        return None

    lines = text.splitlines()
    name = venue = date = None
    m = EVENT_NAME_RE.search(text)
    if m:
        name = norm_space(m.group(1))
    dm = DATE_RE.search(text)
    if dm:
        date = datetime.strptime(re.sub(r"\s+", " ", dm.group(1)), "%B %d, %Y").strftime("%Y-%m-%d")
        for i, ln in enumerate(lines):
            if DATE_RE.search(ln) and i > 0:
                venue = norm_space(lines[i - 1]) or None
                break
    if not name or not date:
        # older layout: "<year> <event name> at <city>" then "<venue> - <Month Day>"
        year_hint = None
        for ln in lines[:6]:
            am = ALT_NAME_RE.match(norm_space(ln))
            if am and not name:
                year_hint, name = int(am.group(1)), norm_space(am.group(2))
            adm = ALT_DATE_RE.match(norm_space(ln))
            if adm and not date and year_hint:
                try:
                    date = datetime.strptime(f"{adm.group(2)}, {year_hint}", "%B %d, %Y").strftime("%Y-%m-%d")
                    venue = venue or norm_space(adm.group(1))
                except ValueError:
                    pass
    rm = ROUND_RE.search(text)
    rnd = norm_round(rm.group(1)) if rm else None

    rows, dropped = [], 0
    seen = set()
    for ln in lines:
        m = ROW_RE.match(ln.strip())
        if not m:
            continue
        nums = [float(x) for x in m.group("nums").split()]
        sub, pen, tot = nums[-3], nums[-2], nums[-1]
        if abs(sub + pen - tot) > 0.011 or not (40.0 <= tot <= 100.0):
            dropped += 1
            continue
        pre = BLOCK_RE.sub("", norm_space(m.group("pre")))
        pre = ORDER_RE.sub("", pre)  # older layout prefixes a performance order number
        nm = NAME_ST_RE.match(pre)
        band, st = (nm.group(1), nm.group(2)) if nm else (pre, "")
        if not band or (band, st) in seen:
            continue
        seen.add((band, st))
        captions = None
        if len(nums) == 14:
            mu, vi, ge = nums[2], nums[5], nums[10]
            if abs(mu + vi + ge - sub) <= 0.02:
                captions = {"mu": mu, "vi": vi, "ge": ge}
        rows.append({
            "band": band, "st": st,
            "cls": CLASS_MAP.get(m.group("cls") or ""),
            "score": round(tot, 3), "sub": round(sub, 3), "pen": round(pen, 3),
            "rating": m.group("rating"),
            "crank": int(m.group("crank")) if m.group("crank") else None,
            "orank": int(m.group("orank")),
            "captions": captions,
        })
    if dropped:
        log(f"{pdf_path.name}: dropped {dropped} rows that did not reconcile")
    if not rows:
        return None
    return {"name": name, "venue": venue, "date": date, "round": rnd, "rows": rows}


# ---------------------------------------------------------------------------
# per-event merge (rounds -> per-class results the app can show)
# ---------------------------------------------------------------------------

def display_name(band: str, st: str) -> str:
    n = re.sub(r"\bH\.?\s?S\.?(?=$|\s)", "HS", band)
    n = norm_space(n).rstrip(",")
    return f"{n} ({st})" if st else n


def merge_event(ev_meta: dict, recaps: list[dict]) -> dict | None:
    """Combine an event's parsed rounds into one record:
    {name, date, venue, url, rounds:{...}, classes:[{class, results}]}."""
    rounds: dict[str, dict] = {}
    for rc in recaps:
        rnd = rc["round"] or "Finals"
        if rnd not in rounds or len(rc["rows"]) > len(rounds[rnd]["rows"]):
            rounds[rnd] = {"date": rc["date"], "rows": rc["rows"],
                           "name": rc["name"], "venue": rc["venue"]}
    if not rounds:
        return None
    # a band's identity, class and per-round scores
    bands: dict[tuple[str, str], dict] = {}
    for ri, rnd in enumerate(ROUNDS):
        if rnd not in rounds:
            continue
        for row in rounds[rnd]["rows"]:
            key = (row["band"], row["st"])
            b = bands.setdefault(key, {"cls": None, "rounds": {}, "last": None})
            b["rounds"][rnd] = row["score"]
            b["last"] = (ri, row)
            if row["cls"]:
                b["cls"] = row["cls"]  # prelims/semis carry the class label

    classes_out = []
    for cls in CLASS_ORDER:
        members = [(k, b) for k, b in bands.items() if b["cls"] == cls]
        if not members:
            continue
        # finalists first (by finals rank/score), then semifinalists, then
        # prelims-only — the order BOA itself reports results in.
        members.sort(key=lambda kb: (-kb[1]["last"][0],
                                     kb[1]["last"][1]["orank"] or 999,
                                     -kb[1]["last"][1]["score"]))
        results = []
        for i, ((band, st), b) in enumerate(members):
            row = b["last"][1]
            r = {"place": i + 1, "corps": display_name(band, st), "score": row["score"],
                 "rounds": {k: v for k, v in b["rounds"].items()}}
            if row["captions"]:
                r["captions"] = row["captions"]
            results.append(r)
        classes_out.append({"class": cls, "results": results})
    if not classes_out:
        return None
    last_rnd = [r for r in ROUNDS if r in rounds][-1]
    name = next((rounds[r]["name"] for r in ROUNDS if r in rounds and rounds[r]["name"]), None)
    venue = next((rounds[r]["venue"] for r in ROUNDS if r in rounds and rounds[r]["venue"]), None)
    date = rounds[last_rnd]["date"] or min(
        (rounds[r]["date"] for r in rounds if rounds[r]["date"]), default=None)
    return {"name": name or ev_meta.get("title") or ev_meta["slug"],
            "date": date, "venue": venue, "url": ev_meta["url"],
            "classes": classes_out}


# ---------------------------------------------------------------------------
# dataset assembly — the exact format scrape_wgi.assemble()/gen_family_data
# publish, rebuilt across every ingested season in the store.
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
    (DOCS_BOA / "seasons").mkdir(parents=True, exist_ok=True)
    (DOCS_BOA / "corps").mkdir(exist_ok=True)
    (DOCS_BOA / "db").mkdir(exist_ok=True)

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
                         "p": r["place"], "s": r["score"]})
                    db_rows.append([year, ev["date"], ev["name"], r["corps"],
                                    c["class"], r["place"], r["score"]])
            season_events.append({
                "name": ev["name"], "date": ev["date"],
                "date_display": datetime.strptime(ev["date"], "%Y-%m-%d").strftime("%B %-d, %Y"),
                "location": ev.get("venue"), "url": ev.get("url"), "source": "boa-recap",
                "classes": ev["classes"], "has_recap": False,
            })
            if "grand national" in (ev["name"] or "").lower():
                for c in ev["classes"]:
                    if c["results"]:
                        top = c["results"][0]
                        champions.setdefault(str(year), {})[c["class"]] = {
                            "corps": top["corps"], "score": top["score"]}
        season_files[year] = season_events

    latest = years[-1]
    classes = [c for c in CLASS_ORDER if any(cls == c for cls, _ in perfs)]
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
        (DOCS_BOA / "corps" / f"{sl}.json").write_text(
            json.dumps({"name": name, "performances": plist}))
        cls_now = plist[-1]["cls"]
        titles = sorted(y for y, cl in champions.items()
                        if any(v.get("corps") == name for v in cl.values()))
        profiles[sl] = {
            "title": name,
            "img": monogram(name),
            "summary": f"{name} competes in Bands of America {cls_now}. "
            + (f"Grand National class champion: {', '.join(titles)}. " if titles else "")
            + f"Scores from official BOA recaps, {yrs[0]}–{yrs[-1]}.",
        }
    idx.sort(key=lambda c: c["name"])

    records = {}
    for cls in classes:
        flat = [(n, p) for (c, n), pl in perfs.items() if c == cls for p in pl]
        top = sorted(flat, key=lambda t: -t[1]["s"])[:10]
        finals = {}
        for y in years:
            rows = sorted(((n, p["s"]) for n, p in flat
                           if p["y"] == y and "grand national" in p["ev"].lower()),
                          key=lambda r: -r[1])
            if rows:
                finals[str(y)] = [[n, s] for n, s in rows]
        records[cls] = {"top": [[p["y"], p["d"], n, p["s"], p["ev"]] for n, p in top],
                        "finals": finals}

    by_decade: dict[str, list] = {}
    for row in db_rows:
        by_decade.setdefault(f"{row[0] // 10 * 10}s", []).append(row)

    w = lambda rel, obj: (DOCS_BOA / rel).write_text(json.dumps(obj))
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
    (DOCS_BOA / "LIVE").write_text(f"live data ingested {updated}\n")
    log(f"boa: wrote {sum(len(v) for v in season_files.values())} events across {years}, "
        f"{sum(len(v['rows']) for v in standings.values())} standings rows, {len(idx)} bands")


# ---------------------------------------------------------------------------
# modes
# ---------------------------------------------------------------------------

def discover(year: int) -> int:
    events = list_events()
    years_probed = {year, year - 1}
    for ev in events:
        if ev["year"] in years_probed:
            info = event_pdfs(ev)
            ev.update(info)
    report = {
        "source": "boa", "probed_at": datetime.now(timezone.utc).isoformat(),
        "index": f"{BASE}/result/", "events": events,
        "pdf_events": sum(1 for e in events if e.get("pdfs")),
        "pdf_total": sum(len(e.get("pdfs", [])) for e in events),
    }
    PROBE_OUT.parent.mkdir(parents=True, exist_ok=True)
    PROBE_OUT.write_text(json.dumps(report, indent=1))
    log(f"boa discover: {len(events)} events, {report['pdf_events']} with recap PDFs "
        f"({report['pdf_total']} PDFs, years {sorted(years_probed)}) -> {PROBE_OUT}")
    return 0 if report["pdf_events"] else 1


def ingest(year: int) -> int:
    events = [e for e in list_events() if e["year"] == year]
    if not events:
        log(f"boa ingest: no events found for {year}")
        return 1
    parsed_events, skipped = [], []
    for ev in events:
        info = event_pdfs(ev)
        recaps = []
        for pdf in info["pdfs"]:
            path = fetch_pdf(pdf["href"])
            if not path:
                continue
            rc = parse_recap(path)
            if rc:
                if not rc["round"]:
                    rc["round"] = pdf["round_guess"]
                recaps.append(rc)
                log(f"  {ev['slug']}: {rc['round']} — {len(rc['rows'])} rows")
        merged = merge_event({**ev, "title": info["title"]}, recaps)
        if merged and merged["date"]:
            parsed_events.append(merged)
        else:
            skipped.append(ev["slug"])
            log(f"  skipped {ev['slug']} (no parseable recap rows)")

    n_rows = sum(len(c["results"]) for e in parsed_events for c in e["classes"])
    bad = [r["score"] for e in parsed_events for c in e["classes"] for r in c["results"]
           if not (40.0 <= r["score"] <= 100.0)]
    if len(parsed_events) < 2 or n_rows < 30 or bad:
        log(f"boa ingest {year}: validation FAILED ({len(parsed_events)} events, {n_rows} rows, "
            f"{len(bad)} out-of-range scores) — keeping existing data")
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
    DOCS_BOA.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    log(f"boa ingest {year}: OK — {len(parsed_events)} events, {n_rows} result rows"
        + (f"; skipped: {', '.join(skipped)}" if skipped else ""))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--ingest", action="store_true")
    ap.add_argument("--year", type=int, default=datetime.now().year)
    args = ap.parse_args()
    if args.discover:
        return discover(args.year)
    if args.ingest:
        return ingest(args.year)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
