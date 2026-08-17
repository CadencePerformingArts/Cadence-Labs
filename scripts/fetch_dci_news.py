#!/usr/bin/env python3
"""DCI news → docs/data/news.json.

Pulls the official dci.org RSS feed (the same articles the site's News page
shows) and stores a compact, classified list the app renders as cards:

  - every item:   title, link, published date, plain-text excerpt, hero image
  - tagged "auditions" when the article announces camps, tryouts or
    recruitment — that tag is what surfaces an item in the app's
    "Auditions & camps" rail, so it updates itself the moment corps
    publish, with a link to the source instead of a guessed date
  - tagged "roundup" for the weekly "Corps news and announcements" digests

Nothing here is invented: if DCI hasn't published it, it isn't in the file.
Runs inside the update cron; on any fetch failure the previous news.json is
left untouched so the app never loses its cards to a flaky request.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

FEED = "https://www.dci.org/feed/"
# input side of the pipeline: build_data.py publishes this into docs/data,
# which is wiped and rebuilt on every cron run
OUT = Path(__file__).resolve().parent.parent / "data" / "parsed" / "dci_news.json"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}"

# words that mean "this is about joining a corps", not about scores.
# Titles get the broad net; article bodies only count on explicit phrases,
# because season recaps mention "camp" and "experience" in passing prose.
AUDITION_TITLE_RX = re.compile(
    r"\baudition|\bcamp\b|\bcamps\b|\btryout|\brecruit|now accepting|"
    r"\bjoin (the |a )?corps|open house", re.I)
AUDITION_BODY_RX = re.compile(
    r"\bauditions?\b|\btryouts?\b|audition camp|now accepting|"
    r"\bjoin (the |a )?corps\b|open house", re.I)
ROUNDUP_RX = re.compile(r"corps news and announcements", re.I)


def text_of(el) -> str:
    return (el.text or "") if el is not None else ""


def strip_html(html: str) -> str:
    s = re.sub(r"<[^>]+>", " ", html)
    s = (
        s.replace("&#8217;", "'").replace("&#8216;", "'")
        .replace("&#8220;", "“").replace("&#8221;", "”")
        .replace("&#8211;", "–").replace("&#8212;", "—")
        .replace("&amp;", "&").replace("&nbsp;", " ").replace("&hellip;", "…")
    )
    return re.sub(r"\s+", " ", s).strip()


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def parse_items(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.findall(".//item"):
        title = strip_html(text_of(it.find("title")))
        link = text_of(it.find("link")).strip()
        if not title or not link:
            continue
        try:
            when = parsedate_to_datetime(text_of(it.find("pubDate"))).date().isoformat()
        except Exception:
            when = ""
        desc = strip_html(text_of(it.find("description")))
        body = text_of(it.find(CONTENT_NS + "encoded"))
        img = None
        m = re.search(r'<img[^>]+src="([^"]+)"', body)
        if m and m.group(1).startswith("https://"):
            img = m.group(1)
        tags = []
        if ROUNDUP_RX.search(title):
            tags.append("roundup")
        if AUDITION_TITLE_RX.search(title) or AUDITION_BODY_RX.search(
                desc + " " + strip_html(body)[:4000]):
            tags.append("auditions")
        items.append({
            "title": title,
            "url": link,
            "date": when,
            "excerpt": desc[:240],
            "image": img,
            "tags": tags,
        })
    return items


def main() -> int:
    try:
        items = parse_items(fetch(FEED))
    except Exception as e:  # noqa: BLE001 — cron must not lose the old file
        print(f"fetch_dci_news: fetch failed, keeping previous news.json ({e})", file=sys.stderr)
        return 0
    if not items:
        print("fetch_dci_news: feed parsed to zero items, keeping previous file", file=sys.stderr)
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": {"name": "DCI.org — official news", "url": "https://www.dci.org/news"},
        "items": items,
    }, ensure_ascii=False, indent=1) + "\n")
    tagged = sum(1 for i in items if "auditions" in i["tags"])
    print(f"fetch_dci_news: {len(items)} items ({tagged} tagged auditions) -> {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
