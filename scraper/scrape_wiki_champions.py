"""Scrape the DCI World Champions table from Wikipedia.

Fills the champions reference for seasons where no championship-finals
event has been scraped yet (chiefly pre-2013). Scraped finals results
always take precedence in build_data.py — this is the documented public
record used as a fallback so the Seasons champions table covers every
year of DCI history.

Output: data/parsed/wiki_champions.json
  {"1972": {"corps": "Anaheim Kingsmen", "score": 88.1}, …}
"""
from __future__ import annotations

import json
import re

from bs4 import BeautifulSoup

from common import ROOT, fetch, log, norm_space, canon_corps

PARSED = ROOT / "data" / "parsed"
URL = "https://en.wikipedia.org/wiki/DCI_World_Championships"


def main():
    PARSED.mkdir(parents=True, exist_ok=True)
    html = fetch(URL, force=True)
    if not html:
        log("wiki fetch failed")
        return
    soup = BeautifulSoup(html, "lxml")

    champs: dict[str, dict] = {}
    for table in soup.find_all("table"):
        head = table.get_text(" ", strip=True)[:200]
        if "Champion" not in head or "Year" not in head:
            continue
        for tr in table.find_all("tr"):
            cells = [norm_space(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
            if not cells or not re.fullmatch(r"\d{4}", cells[0]):
                continue
            year = cells[0]
            champ_cell = cells[1] if len(cells) > 1 else ""
            if re.search(r"cancelled|no scored", champ_cell, re.I):
                continue
            # corps name = text before the "( City, State )" parenthetical
            name = norm_space(re.split(r"\s*\(", champ_cell)[0])
            if not name or len(name) > 45:
                continue
            score = next((c for c in cells[1:] if re.fullmatch(r"\d{2,3}\.\d{1,3}", c)), None)
            champs[year] = {"corps": canon_corps(name),
                            "score": float(score) if score else None}
        if champs:
            break

    p = PARSED / "wiki_champions.json"
    p.write_text(json.dumps(champs, ensure_ascii=False, indent=1))
    log(f"wrote {p}: {len(champs)} seasons ({min(champs)}–{max(champs)})" if champs else "no champions parsed")


if __name__ == "__main__":
    main()
