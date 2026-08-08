#!/usr/bin/env python3
"""BOA (Bands of America) live ingest from the official recap PDFs that
Music for All publishes on marching.musicforall.org.

Source design (verified):
  https://marching.musicforall.org/result/            paginated list of events
  https://marching.musicforall.org/result/<slug>/     one event, links official
                                                      recap PDFs (Prelims /
                                                      Semi-Finals / Finals)

Modes, modeled on scrape_wgi.py:

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
  --ingest-all         walk the ENTIRE results archive (every index page, every
                       event page, every recap PDF — the archive reaches back
                       to 2015) and ingest every year that passes the same
                       validation gates. Years already in the store are left
                       untouched (pass --refresh-year Y to reparse one), so a
                       backfill can never disturb verified seasons. The year of
                       an event comes from the date printed inside its recap
                       PDF — slugs are unreliable ("utah22", "northtexas").
                       Fully resumable: HTML pages are gzip-cached by
                       common.fetch, PDFs land in data/raw/boa_pdf/, and each
                       parsed recap is memoised in data/parsed/boa_recaps/.
                       Writes a per-year audit to data/boa_backfill_report.json.
  --captions           build docs/boa/data/captions/ (index.json + <year>.json)
                       from the per-judge caption columns of every parseable
                       recap PDF, in exactly the schema the DCI app's Captions
                       tab consumes (docs/data/captions/). Caption sums are
                       reconciled against the printed subtotal; rows that fail
                       are excluded and reported per event, never fatal.
  --assemble           rebuild docs/boa/data/ from the existing store without
                       touching the network.

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
PARSED_CACHE = ROOT / "data" / "parsed" / "boa_recaps"
CAPTIONS_DIR = DOCS_BOA / "captions"
BACKFILL_REPORT = ROOT / "data" / "boa_backfill_report.json"
PARSE_VERSION = 5   # bump to invalidate the parsed-recap memo cache
MAX_INDEX_PAGES = 40  # the archive is 22 pages today; headroom for growth

# docs/boa/data/captions/ column order — same structural schema as the DCI
# app's docs/data/captions/ (4 meta cols, caption cols, pen, tot), with keys
# named for BOA's sheet: Music Ind/Ens/Avg, Visual Ind/Ens/Avg, GE Music 1,
# GE Music 2, GE Music total, GE Visual, GE total. Keys the two sheets share
# in meaning (ge1/ge2/ge/vis/mus/pen/tot) reuse the DCI spelling.
CAPTION_COLS = ["date", "event", "class", "corps",
                "mi", "me", "mus", "vi", "ve", "vis",
                "ge1", "ge2", "gem", "gev", "ge", "pen", "tot"]

# BOA recaps label bands 1A/2A/3A/4A (older material sometimes A/AA/AAA/AAAA);
# map both spellings onto the app's class names (docs/boa class_order in
# scripts/gen_family_pages.py: Class AAAA .. Class A).
CLASS_MAP = {
    "1A": "Class A", "2A": "Class AA", "3A": "Class AAA", "4A": "Class AAAA",
    "A": "Class A", "AA": "Class AA", "AAA": "Class AAA", "AAAA": "Class AAAA",
    "Open": "Open Class",  # the 1978-1980 MBA-era top division
}
CLASS_ORDER = ["Open Class", "Class AAAA", "Class AAA", "Class AA", "Class A"]
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


def list_events(max_pages: int = MAX_INDEX_PAGES, *, force: bool = True) -> list[dict]:
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
    if re.search(r"prel|prlm|pre[_.]", f):
        return "Prelims"
    if re.search(r"fin|final", f):
        return "Finals"
    # 2001-2011 uploads end in a bare p/f code: "2003.10.18txarp.pdf"
    if re.search(r"[a-z0-9]p\.pdf$", f) and not f.endswith("recap.pdf"):
        return "Prelims"
    return "Finals"


def event_pdfs(ev: dict, *, force: bool = True) -> dict:
    """Fetch one event page; return {title, pdfs:[{href, round_guess}]}."""
    html = fetch(ev["url"], force=force) or ""
    title = None
    m = TITLE_RE.search(html)
    if m:
        title = norm_space(m.group(1))
    pdfs, other = [], []
    for href in dict.fromkeys(PDF_URL_RE.findall(html)):
        # results PDFs are wildly inconsistently named ("SATX-Finals-Saturday",
        # "2003.10.18txarp", "1991.classA", "1985whitewater") — accept every
        # linked PDF except obvious non-results; the row parser validates the
        # content anyway, so a stray program booklet just parses to nothing.
        if re.search(r"schedule|program|map|press|itinerar|ticket|patron|handbook|logo",
                     href.lower()):
            other.append(href)
        else:
            pdfs.append({"href": href, "round_guess": round_guess(href)})
    return {"title": title, "pdfs": pdfs, "other_pdfs": other}


# ---------------------------------------------------------------------------
# recap PDF parsing
# ---------------------------------------------------------------------------

DATE_RE = re.compile(r"(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})")
# "[ \t]" (not \s) so the standalone "Bands of America" / "Print Back to Top"
# header lines can never satisfy this across a newline.
EVENT_NAME_RE = re.compile(r"^Bands of America[ \t]+(\S.{3,}?)(?:,\s*presented by.*)?\s*$", re.M)
# Older recap layout: "2025 Arizona Regional Championship at Flagstaff, AZ";
# the historic uploads reach back to "1982 Regional Championship at Cullowhee, NC"
ALT_NAME_RE = re.compile(r"^((?:19|20)\d{2})\s+(.{4,}?)(?:\s+at\s+(.+?))?\s*$")
# "<venue> - <date>" where <date> is "September 24" / "October 9, 1982" /
# "10/26/1985" / "9/27" — parsed by _parse_datepart below
ALT_DATE_RE = re.compile(r"^(.*\S)\s+-\s+(.+?)\s*$")
# the round is its own line in the modern layout ("Finals"); the 2015–2022
# generation appends "Recap" ("Semi-Finals Recap")
ROUND_RE = re.compile(r"^\s*(?:Class\s+\S+\s+)?(Prelims|Preliminaries|Semi-?\s?Finals?|Semifinals|Finals)(?:\s+Recap)?(?:\s+Panel\s+\d+)?\s*$", re.M | re.I)
# 2015-era header prints the date as a bare "11/14/15" line
NUM_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$")
# One scored band per line:  [order-no] <name> - <ST> [Block X - Panel N]
#   <floats...> then a tail of  [rating I..III] [class-rank class] overall-rank
ROW_RE = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){4,})\s+"
    r"(?:(?P<rating>I{1,3})\s+)?"
    r"(?:(?P<crank>\d{1,3})\s+(?P<cls>[1-4]A|A{1,4})\s+)?"
    r"(?P<orank>\d{1,3})\s*$")
# 2018-21 prelims insert a "Place in Panel" between class and overall; the
# mandatory roman rating keeps this from swallowing the 90s reversed tails
# ("29 AAA 14 3" = Overall Class InClass Rating), which ROW_RE2 owns.
ROW_RE_PANEL = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){4,})\s+"
    r"(?P<rating>I{1,3})\s+"
    r"(?P<crank>\d{1,3})\s+(?P<cls>[1-4]A|A{1,4})\s+"
    r"\d{1,3}\s+"  # place in panel (not kept)
    r"(?P<orank>\d{1,3})\s*$")
# 1981–1996 generation: pen printed as a bare integer ("0", "1") which breaks
# ROW_RE's float run, the name/state often has no separator ("Norwell H.S. IN"),
# and the tail is reversed — Overall [Class PlaceInClass [Rating]], the rating
# numeric (1..3) in 1995 and roman (I..III) in 1996.
ROW_RE2 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+\.\d{1,3})\s+"
    r"(?P<orank>\d{1,3})"
    r"(?:\s+(?P<cls>[1-4]A|A{1,4})\s+(?P<crank>\d{1,3})(?:\s+(?P<nrating>[1-3]|I{1,3}))?)?\s*$")
# 2008–2011 generation: integer pen but the MODERN tail order
# (Rating PlaceInClass Class Overall) — the mandatory roman rating right after
# the total is what disambiguates it from ROW_RE2's reversed tail.
ROW_RE3 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+\.\d{1,3})\s+"
    r"(?P<rating>I{1,3})\s+"
    r"(?:(?P<crank>\d{1,3})\s+(?P<cls>[1-4]A|A{1,4})\s+)?"
    r"(?P<orank>\d{1,3})\s*$")
# 1986 Grand Nationals finals: integer pen, then just Class Overall
ROW_RE4 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+\.\d{1,3})\s+"
    r"(?P<cls>[1-4]A|A{1,4})\s+"
    r"(?P<orank>\d{1,3})\s*$")
# 1978–1980 MBA-era: all floats, tail is "<rank> <class>" where the rank is
# Place-in-Class on some sheets and Overall on others — the header text
# ("in Class Class" vs "Overall Class") disambiguates per sheet.
ROW_RE5 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<n1>\d{1,3})\s+"
    r"(?P<cls>[1-4]A|A{1,4}|Open)\s*$")
# 1983 Summer Nationals: tail is "Class InClass Overall"
ROW_RE6 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<cls>[1-4]A|A{1,4}|Open)\s+"
    r"(?P<crank>\d{1,3})\s+"
    r"(?P<orank>\d{1,3})\s*$")
# 1997–2000 prelims: tail is "Overall InClass Rating Class"
ROW_RE7 = re.compile(
    r"^(?P<pre>.+?)\s+"
    r"(?P<nums>-?\d+\.\d{1,3}(?:\s+-?\d+\.\d{1,3}){9,})\s+"
    r"(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+\.\d{1,3})\s+"
    r"(?P<orank>\d{1,3})\s+"
    r"(?P<crank>\d{1,3})\s+"
    r"(?P<rating>I{1,3})\s+"
    r"(?P<cls>[1-4]A|A{1,4}|Open)\s*$")
# some 1998–2000 sheets print bare-integer scores ("13", "26") which break
# every float-run pattern above — these two demand EXACTLY the 12 score
# columns plus pen/total so the int/float mix stays unambiguous, and the
# subtotal+pen=total gate downstream rejects any residual misalignment.
_N12 = r"(?P<nums>(?:-?\d+(?:\.\d{1,3})?\s+){11}-?\d+(?:\.\d{1,3})?)"
ROW_RE8 = re.compile(  # prelims tail "Overall InClass Rating Class"
    r"^(?P<pre>.+?)\s+" + _N12 +
    r"\s+(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<orank>\d{1,3})\s+"
    r"(?P<crank>\d{1,3})\s+"
    r"(?P<nrating>I{1,3}|[1-3])\s+"
    r"(?P<cls>[1-4]A|A{1,4}|Open)\s*$")
ROW_RE9 = re.compile(  # finals tail: bare Overall
    r"^(?P<pre>.+?)\s+" + _N12 +
    r"\s+(?P<pen>-?\d+(?:\.\d{1,3})?)\s+"
    r"(?P<tot>-?\d+\.\d{1,3})\s+"
    r"(?P<orank>\d{1,3})\s*$")
BLOCK_RE = re.compile(r"\s+Block\s+\S+\s+-\s+Panel\s+\d+$", re.I)
ORDER_RE = re.compile(r"^\d{1,3}\s+(?=\S)")
NAME_ST_RE = re.compile(r"^(.*\S)\s*(?:\s+-\s+|,\s+)([A-Z]{2})$")
# 80s/90s sheets put the state in its own column with no separator
NAME_ST2_RE = re.compile(r"^(.*\S)\s+([A-Z]{2})$")


_MONTHS = {m.lower()[:3]: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}


def _month_num(tok: str) -> int | None:
    return _MONTHS.get(tok.rstrip(".").lower()[:3])


def _parse_datepart(s: str, year_hint: int | None) -> str | None:
    """Date part of a recap header -> ISO date. Handles every variant the
    archive prints: 'September 24', 'Oct. 10', 'October 29th',
    'October 9, 1982', 'November 7-8, 1981', 'October 31-November 1',
    '10/26/1985', '9/27', '11/14/15', '10/30-31', '10/31-11/1', '10-31-11/1'.
    Spans resolve to their last day. year_hint fills in a missing year."""
    s = norm_space(s)
    s = re.sub(r"^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+", "", s)
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s, flags=re.I)  # October 29th
    m = re.match(r"^([A-Za-z.]+)\s+(\d{1,2})"
                 r"(?:\s*-\s*(?:([A-Za-z.]+)\s+)?(\d{1,2}))?"
                 r"(?:,\s*(\d{4}))?$", s)
    if m:
        mo = _month_num(m.group(3)) if m.group(3) else _month_num(m.group(1))
        dy = int(m.group(4) or m.group(2))
        yr = int(m.group(5)) if m.group(5) else year_hint
        if mo and yr and 1 <= dy <= 31:
            return f"{yr:04d}-{mo:02d}-{dy:02d}"
        return None
    m = re.match(r"^(\d{1,2})\s+([A-Za-z.]+)$", s)  # "31 October"
    if m and _month_num(m.group(2)):
        yr, mo, dy = year_hint, _month_num(m.group(2)), int(m.group(1))
        if yr and 1 <= dy <= 31:
            return f"{yr:04d}-{mo:02d}-{dy:02d}"
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})"
                 r"(?:\s*-\s*(?:(\d{1,2})/)?(\d{1,2}))?"
                 r"(?:/(\d{2,4}))?$", s)
    if m:
        mo, dy = int(m.group(1)), int(m.group(2))
        if m.group(4):
            mo, dy = (int(m.group(3)) if m.group(3) else mo), int(m.group(4))
        yr = int(m.group(5)) if m.group(5) else year_hint
        if yr is not None and yr < 100:
            yr += 1900 if yr > 50 else 2000
        if yr and 1 <= mo <= 12 and 1 <= dy <= 31:
            return f"{yr:04d}-{mo:02d}-{dy:02d}"
    return None


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
    # 2015/2016-generation PDFs render "-" as soft-hyphen + U+2010 runs
    # ("Semi-­‐Finals", "Complex -­‐ September 24") — normalize to ASCII so
    # every dash-sensitive regex below sees one plain hyphen.
    text = text.replace("\xad", "")
    text = re.sub(r"[‐‑‒–—−]", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    # the 2022 Grand Nationals font emits NUL for its ti/tt ligatures
    # ("Grand Na\x00onal", "Dobyns-Benne\x00") — repair the known words, then
    # drop any stragglers so they can't corrupt names.
    if "\x00" in text:
        text = (text.replace("Na\x00onal", "National")
                    .replace("Benne\x00", "Bennett")
                    .replace("\x00", ""))
    # a few CompetitionSuite exports ship no ToUnicode map, so pdfplumber
    # emits raw glyph ids: "(cid:38)(cid:82)..." — those fonts are plain
    # ASCII shifted by 29 ((cid:38)='C', (cid:82)='o'), so decode in place.
    if text.count("(cid:") > 50:
        text = re.sub(r"\(cid:(\d+)\)",
                      lambda m: chr(int(m.group(1)) + 29)
                      if 32 <= int(m.group(1)) + 29 < 127 else " ",
                      text)
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
        # older layout: "<year> <event name> at <city>" then "<venue> - <date>"
        year_hint, city = None, None
        for ln in lines[:8]:
            s = norm_space(ln)
            am = ALT_NAME_RE.match(s)
            if am and not name:
                year_hint, name = int(am.group(1)), norm_space(am.group(2))
                city = norm_space(am.group(3) or "").split(",")[0] or None
                continue
            adm = ALT_DATE_RE.match(s)
            if adm and not date:
                d = _parse_datepart(adm.group(2), year_hint)
                if d:
                    date, venue = d, venue or norm_space(adm.group(1))
                    continue
            nd = NUM_DATE_RE.match(s)
            if nd and not date and name:
                # 2015 Grand Nationals header: venue line, then bare "11/14/15"
                d = _parse_datepart(s, year_hint)
                if d:
                    date = d
        if name and city and re.fullmatch(
                r"(?:(?:Southern|Northern|Eastern|Western|Central)\s+)?(?:Super\s+)?Regional Championships?",
                name, re.I) and city.lower() not in name.lower():
            # historic sheets title every event just "(Southern) Regional
            # Championship" — qualify with the host city so editions and
            # same-season siblings don't collide
            name = f"{city} {name}"
    if name and re.search(r"grand nationals?", name, re.I):
        # the 2021 header doubles the phrase ("Grand National Championships
        # Grand National Championship at ...") — one canonical name, matching
        # what assemble()'s champions detection and the 2024/25 store use.
        name = "Grand National Championships"
    rm = ROUND_RE.search(text)
    rnd = norm_round(rm.group(1)) if rm else None

    rows, dropped = [], 0
    cap_fails: list[str] = []
    seen = set()
    # 1978-80 sheets end rows with "<rank> <class>": the header names that
    # rank column either "in Class Class" or "Overall Class"
    tail5_is_crank = bool(re.search(r"in Class\s+Class\s*$", text, re.M))
    for ln in lines:
        s = ln.strip()
        m = ROW_RE.match(s) or ROW_RE_PANEL.match(s)
        if m:
            nums = [float(x) for x in m.group("nums").split()]
            pre_raw, rating = m.group("pre"), m.group("rating")
            cls_raw, crank, orank = m.group("cls"), m.group("crank"), m.group("orank")
        else:
            m2 = (ROW_RE3.match(s) or ROW_RE2.match(s) or ROW_RE4.match(s)
                  or ROW_RE5.match(s) or ROW_RE6.match(s) or ROW_RE7.match(s)
                  or ROW_RE8.match(s) or ROW_RE9.match(s))
            if not m2:
                continue
            gd = m2.groupdict()
            nums = [float(x) for x in m2.group("nums").split()]
            if "pen" in gd:
                nums += [float(gd["pen"]), float(gd["tot"])]
            pre_raw = m2.group("pre")
            cls_raw, crank, orank = gd.get("cls"), gd.get("crank"), gd.get("orank")
            if "n1" in gd:  # ROW_RE5: rank meaning depends on the header
                if tail5_is_crank:
                    crank = gd["n1"]
                else:
                    orank = gd["n1"]
            nr = gd.get("nrating") or ""
            rating = gd.get("rating") or (nr if nr.startswith("I") else None) \
                or {"1": "I", "2": "II", "3": "III"}.get(nr)
        sub, pen, tot = nums[-3], nums[-2], nums[-1]
        if pen > 0 and abs(sub - pen - tot) <= 0.011:
            pen = -pen  # older recaps print the deduction as a positive number
        if (abs(sub + pen - tot) > 0.011 and len(nums) == 13
                and abs(nums[2] + nums[5] + nums[10] - nums[-2]) <= 0.02
                and -6.0 <= round(nums[-1] - nums[-2], 3) <= 0.011):
            # some 2022 sheets leave the Pen column blank — the tail is then
            # "Subtotal Total" and the caption columns vouch for the subtotal.
            sub, tot = nums[-2], nums[-1]
            pen = round(tot - sub, 3)
            nums = nums[:11] + [sub, pen, tot]
        if abs(sub + pen - tot) > 0.011 or not (40.0 <= tot <= 100.0):
            dropped += 1
            continue
        pre = BLOCK_RE.sub("", norm_space(pre_raw))
        pre = ORDER_RE.sub("", pre)  # older layout prefixes a performance order number
        if re.search(r"[A-Za-z]\d|\d[A-Za-z]", pre):
            # a very long school name overlaps the first score columns on some
            # 2015/16 sheets and pdfplumber interleaves the characters
            # ("...Young Women 1Le2a.3d0ers1 0, .T2X0" = "Leaders, TX" ⨯
            # "12.30 10.20"). The totals tail still reconciles, so keep the
            # row: strip the interleaved digits to recover the name and accept
            # that the two clobbered leading captions are lost for this row.
            pre = norm_space(re.sub(r"[0-9.]+", "", pre)).replace(" ,", ",")
        nm = NAME_ST_RE.match(pre)
        if not nm:
            # 80s/90s sheets: state column with no separator ("Norwell H.S. IN")
            nm2 = NAME_ST2_RE.match(pre)
            if nm2 and nm2.group(2) not in ("II", "III"):
                nm = nm2
        band, st = (nm.group(1), nm.group(2)) if nm else (pre, "")
        if not band or (band, st) in seen:
            continue
        seen.add((band, st))
        captions = caps = None
        n = nums
        if len(nums) == 14:
            # every generation 1982–today prints the same 14 columns (the 80s
            # call Visual "M&M Execution", same arithmetic):
            # MusInd MusEns MusAvg | VisInd VisEns VisAvg |
            # GEMus1 GEMus2 GEMusTot GEVis GETot | Subtotal Pen Total
            mi, me, mu, vi, ve, vs, g1, g2, gm, gv, ge = nums[:11]
            if abs(mu + vs + ge - sub) <= 0.02:
                captions = {"mu": mu, "vi": vs, "ge": ge}
            if (abs(mu + vs + ge - sub) <= 0.02
                    and abs((mi + me) / 2 - mu) <= 0.02
                    and abs((vi + ve) / 2 - vs) <= 0.02
                    and abs(g1 + g2 - gm) <= 0.02
                    and abs(gm + gv - ge) <= 0.02):
                caps = [mi, me, mu, vi, ve, vs, g1, g2, gm, gv, ge]
            else:
                cap_fails.append(f"{band}{' (' + st + ')' if st else ''}")
        elif (len(nums) == 13
                and abs((n[0] + n[1]) / 2 - n[2]) <= 0.02 and abs(n[3] - n[4]) <= 0.02
                and abs(n[5] + n[6] - n[7]) <= 0.02 and abs(n[7] + n[8] - n[9]) <= 0.02
                and abs(n[2] + n[4] + n[9] - sub) <= 0.02):
            # small-panel sheet (some 2025 regionals): one Visual judge only
            caps = [n[0], n[1], n[2], None, n[3], n[4], n[5], n[6], n[7], n[8], n[9]]
            captions = {"mu": n[2], "vi": n[4], "ge": n[9]}
        elif (len(nums) == 12
                and abs(n[0] - n[1]) <= 0.001 and abs(n[2] - n[3]) <= 0.001
                and abs(n[4] + n[5] - n[6]) <= 0.02 and abs(n[6] + n[7] - n[8]) <= 0.02
                and abs(n[1] + n[3] + n[8] - sub) <= 0.02):
            # smallest panel (2025 Toledo): one Music AND one Visual judge —
            # each caption prints judge score then an equal Tot
            caps = [None, n[0], n[1], None, n[2], n[3], n[4], n[5], n[6], n[7], n[8]]
            captions = {"mu": n[1], "vi": n[3], "ge": n[8]}
        elif (len(nums) == 12
                and abs((n[1] + n[2]) / 2 - n[3]) <= 0.02
                and abs(n[4] + n[5] - n[6]) <= 0.02 and abs(n[6] + n[7] - n[8]) <= 0.02
                and abs(n[0] + n[3] + n[8] - sub) <= 0.02):
            # sheet that prints only the Music average (2017 Dallas misprint)
            caps = [None, None, n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8]]
            captions = {"mu": n[0], "vi": n[3], "ge": n[8]}
        elif len(nums) in (12, 13):
            cap_fails.append(f"{band}{' (' + st + ')' if st else ''}")
        rows.append({
            "band": band, "st": st,
            "cls": CLASS_MAP.get(cls_raw or ""),
            "score": round(tot, 3), "sub": round(sub, 3), "pen": round(pen, 3),
            "rating": rating,
            "crank": int(crank) if crank else None,
            "orank": int(orank) if orank else None,
            "captions": captions,
            "caps": caps,
        })
    if dropped:
        log(f"{pdf_path.name}: dropped {dropped} rows that did not reconcile")
    if not rows:
        return None
    return {"name": name, "venue": venue, "date": date, "round": rnd,
            "rows": rows, "cap_fails": cap_fails}


def parse_recap_cached(pdf_path: Path) -> dict | None:
    """parse_recap with an on-disk memo (data/parsed/boa_recaps/) so the
    all-years backfill and the captions build never re-run pdfplumber over a
    PDF that was already parsed by this PARSE_VERSION."""
    PARSED_CACHE.mkdir(parents=True, exist_ok=True)
    cp = PARSED_CACHE / (pdf_path.stem + ".json")
    if cp.exists():
        try:
            memo = json.loads(cp.read_text())
            if memo.get("v") == PARSE_VERSION:
                return memo["recap"]
        except Exception:  # noqa: BLE001
            pass
    rc = parse_recap(pdf_path)
    cp.write_text(json.dumps({"v": PARSE_VERSION, "recap": rc}))
    return rc


# ---------------------------------------------------------------------------
# per-event merge (rounds -> per-class results the app can show)
# ---------------------------------------------------------------------------

def display_name(band: str, st: str) -> str:
    # 2022 recaps spell out "High School" where every other year prints
    # "H.S." — collapse both to "HS" so one band threads across seasons.
    n = re.sub(r"\bHigh School\b", "HS", band, flags=re.I)
    n = re.sub(r"\bH\.?\s?S\.?(?=$|\s)", "HS", n)
    n = norm_space(n).rstrip(",")
    return f"{n} ({st})" if st else n


def merge_event(ev_meta: dict, recaps: list[dict],
                cls_fallback: dict[tuple[str, str], str] | None = None) -> dict | None:
    """Combine an event's parsed rounds into one record:
    {name, date, venue, url, rounds:{...}, classes:[{class, results}]}.
    Two recap PDFs for the same round (Grand Nationals splits Prelims across
    two days/panels) are unioned band-by-band, not either/or. cls_fallback
    maps (band, st) -> class for finals-only sheets, which never print the
    class column."""
    rounds: dict[str, dict] = {}
    for rc in recaps:
        rnd = rc["round"] or "Finals"
        slot = rounds.setdefault(rnd, {"date": None, "rows": [], "name": None,
                                       "venue": None, "_seen": set()})
        slot["date"] = slot["date"] or rc["date"]
        slot["name"] = slot["name"] or rc["name"]
        slot["venue"] = slot["venue"] or rc["venue"]
        for row in rc["rows"]:
            k = (row["band"], row["st"])
            if k not in slot["_seen"]:
                slot["_seen"].add(k)
                slot["rows"].append(row)
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
    if cls_fallback:
        for key, b in bands.items():
            if not b["cls"]:
                b["cls"] = cls_fallback.get(key)

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


# ---------------------------------------------------------------------------
# all-years backfill + captions (both walk the same cached archive crawl)
# ---------------------------------------------------------------------------

def collect_archive(*, fresh: bool = False) -> tuple[list, dict]:
    """Crawl every event page on the results index and parse every recap PDF.
    Returns ([(event_meta, [recap, ...]), ...], notes). Every step is cached
    (HTML gzip via common.fetch, PDFs in data/raw/boa_pdf/, parses memoised in
    data/parsed/boa_recaps/), so an interrupted run resumes for free."""
    events = list_events(force=fresh)
    log(f"boa archive: {len(events)} event pages on the results index")
    collected: list = []
    notes = {"events_without_recaps": [], "pdf_fetch_failures": [],
             "pdf_parse_failures": [], "undated_recaps": [], "unmatched_pdf_links": []}
    for i, ev in enumerate(sorted(events, key=lambda e: e["slug"])):
        if i and i % 25 == 0:
            log(f"  ... {i}/{len(events)} event pages crawled")
        info = event_pdfs(ev, force=fresh)
        notes["unmatched_pdf_links"] += info.get("other_pdfs") or []
        recaps = []
        for pdf in info["pdfs"]:
            path = fetch_pdf(pdf["href"])
            if not path:
                notes["pdf_fetch_failures"].append(pdf["href"])
                continue
            rc = parse_recap_cached(path)
            if not rc:
                notes["pdf_parse_failures"].append(pdf["href"])
                continue
            if not rc["round"]:
                rc["round"] = pdf["round_guess"]
            if not rc["date"]:
                notes["undated_recaps"].append(pdf["href"])
                continue
            recaps.append(rc)
        if recaps:
            collected.append(({**ev, "title": info["title"]}, recaps))
        else:
            notes["events_without_recaps"].append(ev["slug"])
    log(f"boa archive: {len(collected)} events with parseable recaps, "
        f"{len(notes['events_without_recaps'])} without")
    return collected, notes


def year_class_maps(collected: list) -> dict[int, dict[tuple[str, str], str]]:
    """(band, st) -> class per season, by majority vote over every sheet that
    prints the class column — the fallback for finals-only sheets."""
    votes: dict[int, dict[tuple[str, str], dict[str, int]]] = {}
    for _, rcs in collected:
        for rc in rcs:
            y = int(rc["date"][:4])
            for row in rc["rows"]:
                if row["cls"]:
                    v = votes.setdefault(y, {}).setdefault((row["band"], row["st"]), {})
                    v[row["cls"]] = v.get(row["cls"], 0) + 1
    return {y: {k: max(cnt, key=cnt.get) for k, cnt in m.items()}
            for y, m in votes.items()}


def ingest_all(collected: list, refresh_years: set[int],
               min_events: int = 2, min_rows: int = 30) -> dict:
    """Merge every archive year into the store. Years already in the store are
    NEVER touched (unless named in refresh_years), so verified seasons survive
    any backfill. Per-year validation gates match ingest() by default —
    min_events/min_rows let a backfill of the thin 1970s/80s archive keep a
    single-event season whose rows all reconciled; a failing year is reported,
    not fatal."""
    per_year: dict[int, list] = {}
    for ev_meta, rcs in collected:
        byyear: dict[int, list] = {}
        for rc in rcs:
            byyear.setdefault(int(rc["date"][:4]), []).append(rc)
        for y, group in byyear.items():
            per_year.setdefault(y, []).append((ev_meta, group))
    cls_maps = year_class_maps(collected)

    store = {"years": {}}
    if STORE.exists():
        try:
            store = json.loads(STORE.read_text())
        except Exception:  # noqa: BLE001
            pass
    store.setdefault("years", {})

    report: dict[str, dict] = {}
    for year in sorted(per_year):
        merged, seen_keys, dups, skipped = [], set(), [], []
        for ev_meta, rcs in sorted(per_year[year], key=lambda t: t[0]["slug"]):
            m = merge_event(ev_meta, rcs, cls_fallback=cls_maps.get(year, {}))
            if not (m and m["date"]):
                skipped.append(ev_meta["slug"])
                continue
            key = (m["date"], (m["name"] or "").lower())
            if key in seen_keys:  # the same edition published under two slugs
                dups.append(ev_meta["slug"])
                continue
            seen_keys.add(key)
            merged.append(m)
        merged.sort(key=lambda e: e["date"])
        n_rows = sum(len(c["results"]) for e in merged for c in e["classes"])
        bad = [r["score"] for e in merged for c in e["classes"] for r in c["results"]
               if not (40.0 <= r["score"] <= 100.0)]
        info = {"events": len(merged), "rows": n_rows,
                "skipped_events": skipped, "duplicate_pages": dups,
                "out_of_range_scores": len(bad)}
        if str(year) in store["years"] and year not in refresh_years:
            info["status"] = "kept-existing-store"
        elif len(merged) < min_events or n_rows < min_rows or bad:
            info["status"] = "validation-failed"
            log(f"boa ingest-all {year}: validation FAILED ({len(merged)} events, "
                f"{n_rows} rows, {len(bad)} out-of-range) — year not ingested")
        else:
            info["status"] = "ingested"
            store["years"][str(year)] = merged
        log(f"boa ingest-all {year}: {info['status']} — {info['events']} events, "
            f"{info['rows']} rows" + (f"; skipped {skipped}" if skipped else ""))
        report[str(year)] = info

    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    store["updated"] = updated
    DOCS_BOA.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store))
    assemble(store, updated)
    return report


def build_captions(collected: list) -> dict:
    """docs/boa/data/captions/ in exactly the DCI app's schema: index.json
    {seasons:[{year,rows}], cols:[...]} plus one flat row-array file per year.
    One row = one band's judged sheet for one round of one event. Only rows
    whose caption arithmetic reconciles are published; failures are returned
    per event for the report."""
    cls_maps = year_class_maps(collected)
    rows_by_year: dict[int, list] = {}
    seen: set = set()
    fails: list[dict] = []
    unclassed: dict[int, int] = {}
    no_caps_sheets: dict[int, int] = {}
    for ev_meta, rcs in collected:
        for rc in rcs:
            y = int(rc["date"][:4])
            evname = rc["name"] or ev_meta.get("title") or ev_meta["slug"]
            disp_ev = f"{evname} — {rc['round']}"
            if rc.get("cap_fails"):
                fails.append({"year": y, "date": rc["date"], "event": disp_ev,
                              "bands": rc["cap_fails"]})
            got_caps = False
            for row in rc["rows"]:
                caps = row.get("caps")
                if not caps:
                    continue
                got_caps = True
                cls = row["cls"] or cls_maps.get(y, {}).get((row["band"], row["st"]))
                if not cls:
                    unclassed[y] = unclassed.get(y, 0) + 1
                    continue
                corps = display_name(row["band"], row["st"])
                k = (rc["date"], disp_ev, corps)
                if k in seen:
                    continue
                seen.add(k)
                rows_by_year.setdefault(y, []).append(
                    [rc["date"], disp_ev, cls, corps,
                     *[None if v is None else round(v, 3) for v in caps],
                     round(abs(row["pen"]), 3), round(row["score"], 3)])
            if not got_caps:
                no_caps_sheets[y] = no_caps_sheets.get(y, 0) + 1

    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    for y, rows in sorted(rows_by_year.items()):
        rows.sort(key=lambda r: (r[0], r[1], -r[-1]))
        (CAPTIONS_DIR / f"{y}.json").write_text(json.dumps(rows))
    (CAPTIONS_DIR / "index.json").write_text(json.dumps({
        "seasons": [{"year": y, "rows": len(rows_by_year[y])}
                    for y in sorted(rows_by_year)],
        "cols": CAPTION_COLS,
    }))
    log(f"boa captions: {sum(len(r) for r in rows_by_year.values())} rows across "
        f"{len(rows_by_year)} seasons -> {CAPTIONS_DIR}"
        + (f"; {len(fails)} sheets with reconciliation failures" if fails else ""))
    return {"rows": {str(y): len(rows_by_year[y]) for y in sorted(rows_by_year)},
            "reconciliation_failures": fails,
            "rows_without_class": {str(y): n for y, n in sorted(unclassed.items())},
            "sheets_without_captions": {str(y): n for y, n in sorted(no_caps_sheets.items())}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--ingest", action="store_true")
    ap.add_argument("--ingest-all", action="store_true",
                    help="backfill every archive year (existing store years untouched)")
    ap.add_argument("--captions", action="store_true",
                    help="build docs/boa/data/captions/ from every parseable recap")
    ap.add_argument("--assemble", action="store_true",
                    help="rebuild docs/boa/data/ from the existing store, no network")
    ap.add_argument("--fresh", action="store_true",
                    help="refetch index/event HTML instead of trusting the cache")
    ap.add_argument("--refresh-year", type=int, action="append", default=[],
                    help="with --ingest-all: reparse this year even if stored")
    ap.add_argument("--min-events", type=int, default=2,
                    help="with --ingest-all: per-year gate, minimum events")
    ap.add_argument("--min-rows", type=int, default=30,
                    help="with --ingest-all: per-year gate, minimum result rows")
    ap.add_argument("--year", type=int, default=datetime.now().year)
    args = ap.parse_args()
    if args.discover:
        return discover(args.year)
    if args.ingest:
        return ingest(args.year)
    if args.ingest_all or args.captions:
        collected, notes = collect_archive(fresh=args.fresh)
        report = {"generated": datetime.now(timezone.utc).isoformat(), "notes": notes}
        if args.ingest_all:
            report["years"] = ingest_all(collected, set(args.refresh_year),
                                         min_events=args.min_events, min_rows=args.min_rows)
        if args.captions:
            report["captions"] = build_captions(collected)
        BACKFILL_REPORT.parent.mkdir(parents=True, exist_ok=True)
        BACKFILL_REPORT.write_text(json.dumps(report, indent=1))
        log(f"boa backfill report -> {BACKFILL_REPORT}")
        return 0
    if args.assemble:
        if not STORE.exists():
            log("boa --assemble: no store to assemble")
            return 1
        store = json.loads(STORE.read_text())
        assemble(store, store.get("updated")
                 or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
