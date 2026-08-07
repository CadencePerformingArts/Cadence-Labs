"""Corps profiles from Wikipedia — the encyclopedia entry behind each corps.

For every corps that's marched recently (or is historically notable) this
looks up its Wikipedia article, keeps the lead summary + thumbnail from the
REST API, and pulls founded / location / division / director / website out
of the {{Infobox drums corps}} wikitext. Pages are cached like every other
fetch, so after the first run this costs almost nothing.

Output: data/parsed/corps_profiles.json   {slug: {…}}
"""
from __future__ import annotations

import json
import re
from urllib.parse import quote

from common import ROOT, fetch, log, norm_space

PARSED = ROOT / "data" / "parsed"
DOCS = ROOT / "docs" / "data"

API = "https://en.wikipedia.org/w/api.php"
REST = "https://en.wikipedia.org/api/rest_v1/page/summary/"

# infobox fields worth showing, in display order
FIELDS = ("location", "division", "founded", "disbanded", "director", "website")


def _dewiki(s: str) -> str:
    """Flatten common wikitext: links, URL templates, refs, bold quotes."""
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"\{\{URL\|([^}|]+)[^}]*\}\}", r"\1", s, flags=re.I)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)          # drop remaining templates
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "")
    s = re.sub(r"<[^>]+>", " ", s)
    return norm_space(s)


def _infobox_fields(wikitext: str) -> dict:
    i = wikitext.find("{{Infobox")
    if i < 0:
        return {}
    # the infobox ends at the matching closing braces — walk the nesting
    depth = 0
    end = i
    for j in range(i, min(len(wikitext), i + 20000)):
        if wikitext.startswith("{{", j):
            depth += 1
        elif wikitext.startswith("}}", j):
            depth -= 1
            if depth == 0:
                end = j
                break
    box = wikitext[i:end]
    out = {}
    for m in re.finditer(r"^\|\s*([a-z_0-9]+)\s*=\s*(.*?)(?=^\||\Z)", box, re.M | re.S):
        k, v = m.group(1).strip(), _dewiki(m.group(2))
        if k in FIELDS and v:
            out[k] = v[:160]
    return out


def _wiki_lookup(name: str) -> dict | None:
    """Search → summary → infobox; None unless the page is really a corps."""
    q = quote(f"{name} drum and bugle corps")
    sr = fetch(f"{API}?action=query&list=search&srsearch={q}&srlimit=5&format=json",
               accept_json=True)
    if not sr:
        return None
    try:
        hits = json.loads(sr)["query"]["search"]
    except Exception:  # noqa: BLE001
        return None
    for hit in hits[:3]:
        title = hit["title"]
        summ = fetch(REST + quote(title.replace(" ", "_")), accept_json=True)
        if not summ:
            continue
        try:
            s = json.loads(summ)
        except Exception:  # noqa: BLE001
            continue
        extract = s.get("extract") or ""
        # the page must actually be about a drum corps, and about THIS one:
        # every distinctive word of the corps' name must appear in the page
        # TITLE (generic words like drum/corps/bugle match everything and
        # once sent "3rd Regiment" to Phantom Regiment's article)
        if "drum" not in extract.lower():
            continue
        generic = {"the", "and", "of", "drum", "drums", "corps", "bugle"}
        keywords = [w for w in re.split(r"[^A-Za-z0-9]+", name)
                    if len(w) >= 2 and w.lower() not in generic]
        tl = title.lower()
        if not keywords or not all(w.lower() in tl for w in keywords):
            continue
        prof = {
            "wiki": (s.get("content_urls") or {}).get("desktop", {}).get("page")
                    or f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}",
            "title": title,
            "summary": norm_space(extract)[:520],
        }
        thumb = (s.get("thumbnail") or {}).get("source")
        if thumb:
            prof["img"] = thumb
        wt = fetch(f"{API}?action=query&prop=revisions&rvprop=content&rvslots=main"
                   f"&titles={quote(title)}&format=json&formatversion=2", accept_json=True)
        if wt:
            try:
                pages = json.loads(wt)["query"]["pages"]
                content = pages[0]["revisions"][0]["slots"]["main"]["content"]
                prof.update(_infobox_fields(content))
            except Exception:  # noqa: BLE001
                pass
        return prof
    return None


def main():
    idx_path = DOCS / "corps_index.json"
    if not idx_path.exists():
        log("no corps_index.json yet — run the site build first")
        return
    idx = json.loads(idx_path.read_text())
    targets = [c for c in idx
               if c.get("last", 0) >= 2010 or c.get("seasons", 0) >= 12
               or (c.get("best") or 0) >= 88]
    log(f"profiles: {len(targets)} corps in scope")

    out_path = PARSED / "corps_profiles.json"
    profiles = {}
    if out_path.exists():
        try:
            profiles = json.loads(out_path.read_text())
        except Exception:  # noqa: BLE001
            profiles = {}

    looked = found = 0
    for c in targets:
        slug = c["slug"]
        if slug in profiles:          # cached result (hits or misses) stands
            continue
        looked += 1
        try:
            prof = _wiki_lookup(c["name"])
        except Exception as e:  # noqa: BLE001
            log(f"profile FAIL {c['name']}: {e}")
            continue
        profiles[slug] = prof or {}   # {} = looked up, nothing usable
        if prof:
            found += 1
        if looked % 25 == 0:
            out_path.write_text(json.dumps(profiles, ensure_ascii=False, indent=1))
            log(f"...{looked} looked up, {found} found")
    out_path.write_text(json.dumps(profiles, ensure_ascii=False, indent=1))
    have = sum(1 for v in profiles.values() if v)
    log(f"wrote {out_path}: {have} profiles ({looked} new lookups this run)")


if __name__ == "__main__":
    main()
