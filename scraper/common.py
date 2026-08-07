"""Shared fetch/cache utilities for the DCI/DCA dashboard scrapers.

Design:
  - Every fetched page is cached gzipped under data/raw/ so parsing can be
    re-run offline and daily runs only fetch what changed.
  - Polite: rate-limited, identifies itself, retries with backoff.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "docs" / "data"

RATE_LIMIT_SECONDS = 1.5

# Transport: plain curl with its default identity. dci.org's bot protection
# started rejecting the python-requests client (HTTP 403 + challenge page)
# while stock curl from the same runners passes — likely because a browser
# User-Agent on a non-browser TLS stack looks spoofed, whereas curl is
# honest about what it is. So the fetcher IS curl now; requests remains
# only as a fallback where curl isn't installed.
_CURL = shutil.which("curl")
_session = requests.Session()
_last_fetch = [0.0]

# dci.org sits behind Cloudflare, which sometimes serves a blanket managed
# challenge ("Just a moment...") to cloud-runner IPs — no client on the
# runner can pass it. When that happens, route dci.org reads through the
# Cadence push relay (different network), which exposes a dci.org-only
# /fetch endpoint. Direct is always tried first, so the moment the
# challenge lifts we go back to fetching straight from the source.
DCI_RELAY = os.environ.get("DCI_RELAY", "https://cadenceapp.up.railway.app/fetch?url=")
_relay_mode = [False]
# per-run circuit breaker: once dci.org is confirmed blocked (a challenge, a
# 403/429, or repeated timeouts — the block has shown up as all three), stop
# hammering it and let the fallback sources cover the run. Resets each run, so
# the moment dci.org is reachable again the first fetch succeeds and normal
# scraping resumes. This is what keeps a blocked cycle to seconds instead of
# burning the whole ~9-minute deadline on retry backoff.
_dci_down = [False]


def _is_challenge(status: int, text: str, resp_headers: dict) -> bool:
    return status == 403 and (
        resp_headers.get("cf-mitigated") == "challenge"
        or "Just a moment" in text[:2000]
        or "challenges.cloudflare.com" in text[:4000]
    )


def http_get(url: str, timeout: int = 30, headers: dict | None = None):
    """Single GET with automatic Cloudflare-challenge failover for dci.org.
    Returns (status_code, text, response_headers-lowercased)."""
    relayable = bool(DCI_RELAY) and urlparse(url).netloc == "www.dci.org"
    if relayable and not _relay_mode[0]:
        status, text, rh = _raw_get(url, timeout=timeout, headers=headers)
        if not _is_challenge(status, text, rh):
            return status, text, rh
        log(f"cloudflare challenge on {url} — switching to relay for this run")
        _relay_mode[0] = True
    if relayable:
        return _raw_get(DCI_RELAY + quote(url, safe=""), timeout=timeout + 10, headers=headers)
    return _raw_get(url, timeout=timeout, headers=headers)


def _raw_get(url: str, timeout: int = 30, headers: dict | None = None):
    """One curl GET, no policy. Returns (status_code, text, headers-lowercased)."""
    headers = headers or {}
    if _CURL:
        hdr_args = []
        for k, v in headers.items():
            hdr_args += ["-H", f"{k}: {v}"]
        with tempfile.NamedTemporaryFile(suffix=".body", delete=False) as bf:
            body_path = Path(bf.name)
        try:
            r = subprocess.run(
                [_CURL, "-sS", "-L", "--compressed", "--max-time", str(timeout),
                 "-o", str(body_path), "-D", "-", "-w", "\n%{http_code}",
                 *hdr_args, url],
                capture_output=True, text=True, timeout=timeout + 20)
            lines = (r.stdout or "").strip().splitlines()
            code = int(lines[-1]) if lines and lines[-1].strip().isdigit() else 0
            if code == 0:
                raise RuntimeError(f"curl: {(r.stderr or 'no response').strip()[:200]}")
            resp_headers = {}
            for ln in lines[:-1]:  # last redirect's block wins, which is what we want
                if ":" in ln:
                    k, _, v = ln.partition(":")
                    resp_headers[k.strip().lower()] = v.strip()
            text = body_path.read_text(encoding="utf-8", errors="replace")
            return code, text, resp_headers
        finally:
            body_path.unlink(missing_ok=True)
    r = _session.get(url, timeout=timeout, headers=headers)
    return r.status_code, r.text, {k.lower(): v for k, v in r.headers.items()}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def cache_path(url: str) -> Path:
    p = urlparse(url)
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", (p.path + ("_" + p.query if p.query else "")).strip("/"))[:180]
    h = hashlib.sha1(url.encode()).hexdigest()[:10]
    return RAW / p.netloc / f"{slug}_{h}.gz"


def fetch(url: str, *, force: bool = False, timeout: int = 30, retries: int | None = None,
          accept_json: bool = False) -> str | None:
    """Fetch a URL with on-disk gzip cache. Returns text, or None on hard failure.
    retries defaults to $FETCH_RETRIES (or 4); a caller/env can lower it so a
    throttled source fails fast instead of retry-storming under a time cap."""
    if retries is None:
        try:
            retries = int(os.environ.get("FETCH_RETRIES", "4"))
        except ValueError:
            retries = 4
    cp = cache_path(url)
    if cp.exists() and not force:
        with gzip.open(cp, "rt", encoding="utf-8", errors="replace") as f:
            return f.read()

    is_dci = urlparse(url).netloc == "www.dci.org"
    if is_dci and _dci_down[0]:
        return None  # already confirmed blocked this run — skip instantly

    headers = {}
    if accept_json:
        headers["Accept"] = "application/json"

    delay = 5.0
    for attempt in range(retries):
        wait = RATE_LIMIT_SECONDS - (time.time() - _last_fetch[0])
        if wait > 0:
            time.sleep(wait)
        try:
            _last_fetch[0] = time.time()
            status, text, resp_headers = http_get(url, timeout=timeout, headers=headers)
            if status == 404:
                log(f"404 {url}")
                return None
            challenge = _is_challenge(status, text, resp_headers)
            # dci.org is either reachable (200) or blocked — a 403/429/challenge
            # is IP-based and won't clear on retry, so trip the run's breaker and
            # let the fallback sources cover it instead of burning the deadline.
            if challenge or (is_dci and status in (403, 429)):
                if is_dci and not _dci_down[0]:
                    _dci_down[0] = True
                    log(f"dci.org blocked (HTTP {status}) — skipping it for the rest of this run; fallbacks will cover")
                elif not is_dci:
                    log(f"{status} on {url}; skipping")
                return None
            if status in (403, 429):
                # ordinary (non-dci) bot-wall / throttle: back off before retry
                retry_after = int(resp_headers.get("retry-after") or 0)
                pause = max(retry_after, 45 * (attempt + 1))
                log(f"{status} throttle on {url}; sleeping {pause}s")
                time.sleep(pause)
                continue
            if status >= 400:
                raise requests.HTTPError(f"{status} for {url}")
            cp.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(cp, "wt", encoding="utf-8") as f:
                f.write(text)
            return text
        except Exception as e:  # noqa: BLE001
            log(f"fetch attempt {attempt + 1}/{retries} failed: {url}: {e}")
            # dci.org timing out is another face of the block: give it one
            # retry, then trip the breaker so the run doesn't stall on it.
            if is_dci and attempt >= 1:
                _dci_down[0] = True
                log("dci.org unreachable (timeouts) — skipping it for the rest of this run")
                return None
            time.sleep(delay)
            delay *= 2
    if is_dci:
        _dci_down[0] = True
    return None


def write_json(relpath: str, obj) -> None:
    p = OUT / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {p} ({p.stat().st_size:,} bytes)")


def read_json(relpath: str, default=None):
    p = OUT / relpath
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8"))


def norm_space(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# Canonical corps-name normalization: map common variants to one display name
# so per-corps history threads correctly across 50 years of typography.
CORPS_ALIASES = {
    # archive-cleanup merges (data-audit fleet, adversarially verified)
    "minnesota brass, inc.": "Minnesota Brass",
    "minnesota brass inc.": "Minnesota Brass",
    "minnesota brass, sr.": "Minnesota Brass",
    "colt .45": "Colts",
    "colt.45": "Colts",
    "colt .45's": "Colts",
    "colt .45s": "Colts",
    "colt 45": "Colts",
    "colt 45s": "Colts",
    "arbella - salem, ma": "Arbella",
    "arbella - salem, ma.": "Arbella",
    "arbella-salem,ma.": "Arbella",
    "argonauts - salem, or": "Argonauts",
    "bandettes - sault ste. marie, ont": "Bandettes",
    "barons of steuben - corning, ny": "Barons of Steuben",
    "black knights - bellville, il": "Black Knights",
    "blue saints, sudbury, on": "Blue Saints",
    "bluewater buccaneers - sarnia, ont": "Bluewater Buccaneers",
    "bluewater buccaneers - sarnia, ont.": "Bluewater Buccaneers",
    "bluewater buccaneers, sarnia, on": "Bluewater Buccaneers",
    "brantford girls, brantford, on": "Brantford Girls",
    "cmcc warriors - bronx, ny": "CMCC Warriors",
    "cadets of dutch boy, kitchener, on": "Cadets of Dutch Boy",
    "cambria cadets - ebensburg, pa": "Cambria Cadets",
    "cambria cadets-edensburg, pa": "Cambria Cadets",
    "canadian knights, peterborough, on": "Canadian Knights",
    "canadian knights, warsaw, on": "Canadian Knights",
    "cardinal cadets, scaborough, on": "Cardinal Cadets",
    "cardinal cadets, scarborough, on": "Cardinal Cadets",
    "cavalier cadets - rosemont, il": "Cavalier Cadets",
    "conquistadors - s. san francisco, ca": "Conquistadors",
    "conquistadors - s. san francisco, ca.": "Conquistadors",
    "crimson cadets - norfolk, ne": "Crimson Cadets",
    "durham girls, durham, on": "Durham Girls",
    "dutch boy - kitchener, ont": "Dutch Boy",
    "dutch boy - kitchener, ont.": "Dutch Boy",
    "dutch boy cadets, kitchener, on": "Dutch Boy Cadets",
    "dutch boy cadets, kitchner, on": "Dutch Boy Cadets",
    "eagles of central new york - verona, ny": "Eagles of Central New York",
    "firebirds - rochester, ny": "Firebirds",
    "firebirds-rochester,ny": "Firebirds",
    "florida wave - miami, fl": "Florida Wave",
    "fusion - rochester, ny": "Fusion",
    "fusion-rochester,ny": "Fusion",
    "gauchos - fulton, ny": "Gauchos",
    "georgian lancers, owen sound, on": "Georgian Lancers",
    "glassmen - toledo, oh": "Glassmen",
    "golden garrison- ypsilanti, mich.": "Golden Garrison",
    "hyliters, toronto, on": "Hyliters",
    "kiwanis kavaliers - kitchener, ont": "Kiwanis Kavaliers",
    "kiwanis kavaliers, kitchener, on": "Kiwanis Kavaliers",
    "les eclipses - longueuil, que": "Les Eclipses",
    "madison junior scouts, madison, wi": "Madison Junior Scouts",
    "malden diplomats - malden, ma": "Malden Diplomats",
    "marion cadets - marion, oh": "Marion Cadets",
    "marquis - fond du lac, wi": "Marquis",
    "marquis fond du lac, wi": "Marquis",
    "mello-dears - owego, ny": "Mello-Dears",
    "mello-dears-owego,ny": "Mello-Dears",
    "memorial lancers - st. louis, mo": "Memorial Lancers",
    "new york lancers - bronx, ny": "New York Lancers",
    "new york lancers, bronx, ny": "New York Lancers",
    "niagara frontiersmen - tonawanda, ny": "Niagara Frontiersmen",
    "phantom regiment cadets - rockford, il": "Phantom Regiment Cadets",
    "pioneer - milwaukee, wi": "Pioneer",
    "pioneer scouts - lebanon, pa": "Pioneer Scouts",
    "pioneer scouts-lebanon, pa": "Pioneer Scouts",
    "royal cadets - east templeton, ma": "Royal Cadets",
    "royalaires - flint, mich.": "Royalaires",
    "sacred heart crusaders (manville nj)": "Sacred Heart Crusaders",
    "sacred heart crusaders manville, nj": "Sacred Heart Crusaders",
    "manville sacred heart": "Sacred Heart Crusaders",
    "shoreliners - lynn, ma": "Shoreliners",
    "st. ignatius-hicksville,ny": "St. Ignatius",
    "suburbanettes - hudson, nh": "Suburbanettes",
    "valley-airs-nortbridge, ma.": "Valley-Airs",
    "ventures - kitchener, ont.": "Ventures",
    "wausau story - wausau, wi": "Wausau Story",
    "wausau story wausau, wi": "Wausau Story",
    "yankee cadets - utica, ny": "Yankee Cadets",
    "3rd regiment": "3rd Regiment",
    "arc-en-ciel": "Arc-en-Ciel",
    "beverly cardinals": "Beverly Cardinals",
    "connexion quebec": "Connexion Quebec",
    "fire-ettes": "Fire-ettes",
    "fire-ettes norwich, ct": "Fire-ettes",
    "imperial regiment": "Imperial Regiment",
    "legend of texas": "Legend of Texas",
    "les troubadours": "Les Troubadours",
    "les troubadors": "Les Troubadours",
    "ohio brass factory": "Ohio Brass Factory",
    "rhode island matadors": "Rhode Island Matadors",
    "sacred heart crusaders": "Sacred Heart Crusaders",
    "spirit of newark": "Spirit of Newark",
    "ventures": "Ventures",
    "socal dream minicorps": "SoCal Dream MiniCorps",
    "star united minicorps": "Star United MiniCorps",
    "chops inc": "Chops, Inc.",
    "chops inc.": "Chops, Inc.",
    "chops inc., sr.": "Chops, Inc.",
    "' 76ers": "76ers",
    "76'ers": "76ers",
    "black watch, nj": "Black Watch (NJ)",
    "black watch - willingboro, nj": "Black Watch (NJ)",
    "black watch-willingboro,nj": "Black Watch (NJ)",
    "black watch willingboro, nj": "Black Watch (NJ)",
    "fitchburg kingsmen - ma": "Fitchburg Kingsmen",
    "fitchburg kingsmen, ma": "Fitchburg Kingsmen",
    "kingsmen - fitchburg, ma.": "Fitchburg Kingsmen",
    "fitchburg kingsmen sr": "Fitchburg Kingsmen",
    "govenaires, sr.": "Govenaires",
    "governaires, sr.": "Govenaires",
    "ambassadors, newmarket, on": "Ambassadors, Aurora/Newmarket, ON",
    "tri town cadets": "Tri-Town Cadets",
    "tritown cadets": "Tri-Town Cadets",
    "cadets lasalle": "Cadets La Salle",
    "the brigadiers": "Syracuse Brigadiers",
    "concord blue devils": "Blue Devils",
    "concord blue devils b": "Blue Devils B",
    "new york skyliners": "Skyliners",
    "anaheim kingsmen": "Kingsmen",
    "long island sunrisers": "Sunrisers",
    "the cadets": "The Cadets",
    "cadets": "The Cadets",
    "holy name cadets": "The Cadets",
    "cadets of bergen county": "The Cadets",
    "garfield cadets": "The Cadets",
    "the cavaliers": "The Cavaliers",
    "cavaliers": "The Cavaliers",
    "the academy": "The Academy",
    "academy": "The Academy",
    "santa clara vanguard": "Santa Clara Vanguard",
    "vanguard": "Santa Clara Vanguard",
    "scv": "Santa Clara Vanguard",
    "27th lancers": "27th Lancers",
    "blue devils": "Blue Devils",
    "bluecoats": "Bluecoats",
    "phantom regiment": "Phantom Regiment",
    "madison scouts": "Madison Scouts",
    "the madison scouts": "Madison Scouts",
    "carolina crown": "Carolina Crown",
    "boston crusaders": "Boston Crusaders",
    "crossmen": "Crossmen",
    "blue knights": "Blue Knights",
    "blue stars": "Blue Stars",
    "colts": "Colts",
    "troopers": "Troopers",
    "spirit of atlanta": "Spirit of Atlanta",
    "spirit": "Spirit of Atlanta",
    "spirit from jsu": "Spirit of Atlanta",
    "mandarins": "Mandarins",
    "pacific crest": "Pacific Crest",
    "music city": "Music City",
    "genesis": "Genesis",
    "seattle cascades": "Seattle Cascades",
    "cascades": "Seattle Cascades",
    "jersey surf": "Jersey Surf",
    "the battalion": "The Battalion",
    "battalion": "The Battalion",
    "golden empire": "Golden Empire",
    "gold": "Gold",
    "guardians": "Guardians",
    "vessel": "Vessel",
    "impulse": "Impulse",
    "vanguard cadets": "Vanguard Cadets",
    "santa clara vanguard cadets": "Vanguard Cadets",
    "blue devils b": "Blue Devils B",
    "blue devils c": "Blue Devils C",
    "star of indiana": "Star of Indiana",
    "suncoast sound": "Suncoast Sound",
    "sky ryders": "Sky Ryders",
    "velvet knights": "Velvet Knights",
    "freelancers": "Freelancers",
    "north star": "North Star",
    "bridgemen": "Bridgemen",
    "crossmen of san antonio": "Crossmen",
    "glassmen": "Glassmen",
    "kiwanis kavaliers": "Kiwanis Kavaliers",
    "carolina gold": "Carolina Gold",
    "atlanta cv": "Atlanta CV",
    "cv": "Atlanta CV",
    "reading buccaneers": "Reading Buccaneers",
    "buccaneers": "Reading Buccaneers",
    "hawthorne caballeros": "Hawthorne Caballeros",
    "caballeros": "Hawthorne Caballeros",
    "bushwackers": "Bushwackers",
    "fusion core": "Fusion Core",
    "cadets2": "Cadets2",
    "sun devils": "Sun Devils",
    "white sabers": "White Sabers",
    "governaires": "Govenaires",
    "govenaires": "Govenaires",
    "minnesota brass": "Minnesota Brass",
    "mn brass": "Minnesota Brass",
    "kilties": "Kilties",
    "royal airs": "Royal Airs",
    "skyliners": "Skyliners",
    "empire statesmen": "Empire Statesmen",
    "syracuse brigadiers": "Syracuse Brigadiers",
    "brigadiers": "Syracuse Brigadiers",
}


def canon_corps(name: str) -> str:
    n = norm_space(name)
    n = n.replace("\u2019", "'").replace("\u2018", "'")  # curly apostrophes split identities
    n = re.sub(r"\s*\((?:World|Open|All[- ]Age|Int'l|International|Class A|Exhibition)[^)]*\)\s*$", "", n, flags=re.I)
    n = re.sub(r'["“”]', "", n)  # Blue Devils "B" → Blue Devils B
    n = norm_space(n.rstrip("*+^~, "))
    key = n.lower().strip()
    return CORPS_ALIASES.get(key, n)


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "x"
