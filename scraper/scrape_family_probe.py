#!/usr/bin/env python3
"""Discovery probes for the remaining family data sources. Each probe fetches
that circuit's public results surfaces, inventories score/result links (and
any CompetitionSuite GUIDs), and writes data/<source>_probe.json — evidence
to design the real adapter against, exactly how the WGI ingest started.
Probes never write to docs/.

    PYTHONPATH=scraper python3 scraper/scrape_family_probe.py --source boa
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone

from common import ROOT, fetch, log

GUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
LINK_RE = re.compile(r'href="([^"]+)"[^>]*>([^<]{0,120})', re.I)
HINT = re.compile(r"score|result|recap|standing|placement|champion", re.I)

SOURCES = {
    "boa": [
        "https://marching.musicforall.org/scores/",
        "https://marching.musicforall.org/schedule/",
        "https://musicforall.org/our-programs/marching/",
    ],
    "showchoir": [
        "https://www.showchoirscores.com/",
        "https://showchoir.com/events/",
    ],
}


def probe(source: str) -> int:
    report = {"source": source, "probed_at": datetime.now(timezone.utc).isoformat(), "pages": []}
    for url in SOURCES[source]:
        html = fetch(url) or ""
        page = {"url": url, "bytes": len(html), "guids": sorted(set(GUID_RE.findall(html)))[:20],
                "competitionsuite": "competitionsuite" in html.lower(), "links": []}
        for href, text in LINK_RE.findall(html):
            if HINT.search(href) or HINT.search(text):
                page["links"].append({"href": href[:200], "text": text.strip()[:80]})
            if len(page["links"]) >= 40:
                break
        report["pages"].append(page)
    out = ROOT / "data" / f"{source}_probe.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    hits = sum(len(p["links"]) for p in report["pages"])
    log(f"{source} probe: {hits} candidate links, "
        f"compsuite={any(p['competitionsuite'] for p in report['pages'])} -> {out}")
    return 0 if hits else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=sorted(SOURCES), required=True)
    return probe(ap.parse_args().source)


if __name__ == "__main__":
    sys.exit(main())
