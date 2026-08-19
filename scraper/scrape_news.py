"""Scrape dci.org news for the app's News & Announcements feed.

Two sources on dci.org:
  1. /news — the article index (WordPress, server-rendered): headline cards
     with a MM-DD-YYYY date and an <h3><a> title/link.
  2. The recurring "Corps news and announcements" roundups — DCI staff compile
     per-corps announcement blurbs (<article class="news-item"> blocks with the
     corps logo, name, blurb, and an outbound link). During the off-season this
     is the closest thing to a central database of camp/audition/show
     announcements, so it powers the app's announcement cards.

Each corps item is tagged by keyword: "auditions" (camps, tryouts, interest
forms), "announcement" (next-season reveals), else "news".

Output: data/parsed/dci_news.json
  { updated, articles: [{title,url,date}],
    corps_items: [{corps,blurb,link,logo,kind,date}] }
"""
from __future__ import annotations

import html as _html
import json
import re
from datetime import datetime, timezone

from common import ROOT, fetch, log, norm_space

PARSED = ROOT / "data" / "parsed"
INDEX = "https://www.dci.org/news"

ARTICLE = re.compile(
    r"<span>(\d{2})-(\d{2})-(\d{4})[^<]*</span>.*?<h3[^>]*>\s*"
    r'<a href="(https?://www\.dci\.org/news/[^"]+)"[^>]*>\s*([^<]+?)\s*</a>', re.S)
ITEM = re.compile(
    r'<article class="news-item">.*?<img[^>]*src="([^"]*)"[^>]*alt="([^"]*?)\s*logo"'
    r".*?<h2>([^<]+)</h2>\s*<p>(.*?)</p>.*?"
    r'<a class="news-link" href="([^"]+)"', re.S)

AUDITION = re.compile(r"audition|tryout|try-?out|camp\b|boot ?camp|interest form|recruit|"
                      r"registration|open house|clinic|join the corps|march(?:ing)? with", re.I)
ANNOUNCE = re.compile(r"announc|reveal|2027|next summer|next season|show title|theme|"
                      r"director|staff|tour dates", re.I)


FEED = "https://www.dci.org/feed/"
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}"
# WordPress serves its emoji glyphs as images from s.w.org — never a thumbnail
EMOJI_IMG = re.compile(r"s\.w\.org/images/core/emoji", re.I)
FIRST_IMG = re.compile(r'<img[^>]+src="(https://[^"]+)"', re.I)


def feed_articles() -> list[dict]:
    """Articles straight from the WordPress RSS feed: title, url, date, and
    the first real content image. The feed is both the thumbnail source AND
    the fallback headline source — /news and /feed/ are separate endpoints,
    so a blocked or redesigned index page can't blank the app's news rail as
    long as the feed answers."""
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    xml = fetch(FEED) or ""
    if not xml:
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out: list[dict] = []
    for it in root.findall(".//item"):
        link = (it.findtext("link") or "").strip()
        title = norm_space(_html.unescape(it.findtext("title") or ""))
        if not link or not title:
            continue
        date = ""
        try:
            date = parsedate_to_datetime(it.findtext("pubDate") or "").strftime("%Y-%m-%d")
        except Exception:
            pass
        a = {"title": title, "url": link, "date": date}
        body = it.findtext(CONTENT_NS + "encoded") or ""
        for src in FIRST_IMG.findall(body):
            if not EMOJI_IMG.search(src):
                a["image"] = src
                break
        out.append(a)
    return out


def kind_of(blurb: str) -> str:
    if AUDITION.search(blurb):
        return "auditions"
    if ANNOUNCE.search(blurb):
        return "announcement"
    return "news"


def strip_tags(s: str) -> str:
    return norm_space(_html.unescape(re.sub(r"<[^>]+>", " ", s)))


def main() -> int:
    html = fetch(INDEX, force=True, retries=1) or fetch(INDEX) or ""
    from_feed = feed_articles()

    articles, seen = [], set()
    for mo, dd, yy, url, title in ARTICLE.findall(html):
        if url in seen:
            continue
        seen.add(url)
        articles.append({"title": norm_space(_html.unescape(title)), "url": url,
                         "date": f"{yy}-{mo}-{dd}"})
    articles.sort(key=lambda a: a["date"], reverse=True)

    if articles:
        # Headline thumbnails come from the RSS feed's content:encoded — the
        # index page carries none. Best-effort: a dead feed just means text
        # cards. WordPress inlines its emoji glyphs as s.w.org SVG <img>s, and
        # an article whose only image is an emoji must render as text, not as
        # a thumbnail of a camera emoji (that shipped once).
        imgs = {a["url"]: a["image"] for a in from_feed if a.get("image")}
        for a in articles:
            img = imgs.get(a["url"])
            if img:
                a["image"] = img
    elif from_feed:
        # index blocked or redesigned — the feed alone still carries the
        # latest headlines, so the news rail never goes dark over one endpoint
        log("news: index gave no articles — using the RSS feed's")
        articles = sorted(from_feed, key=lambda a: a["date"], reverse=True)
    else:
        log("news: index and feed both unreachable — keeping existing file")
        return 0

    # the last few weekly roundups carry the per-corps announcements
    roundups = [a for a in articles if "corps-news-and-announcements" in a["url"]][:3]
    corps_items, item_seen = [], set()
    for r in roundups:
        page = fetch(r["url"]) or ""
        for logo, alt, name, blurb, link in ITEM.findall(page):
            corps = norm_space(name) or norm_space(alt)
            text = strip_tags(blurb)
            key = corps + "|" + text[:80]
            if not corps or not text or key in item_seen:
                continue
            item_seen.add(key)
            corps_items.append({"corps": corps, "blurb": text, "link": link,
                                "logo": logo, "kind": kind_of(text), "date": r["date"]})

    PARSED.mkdir(parents=True, exist_ok=True)
    out = PARSED / "dci_news.json"
    out.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "articles": articles[:25],
        "corps_items": corps_items,
    }, ensure_ascii=False, indent=1))
    log(f"wrote {out}: {len(articles)} articles, {len(corps_items)} corps items "
        f"from {len(roundups)} roundup(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
