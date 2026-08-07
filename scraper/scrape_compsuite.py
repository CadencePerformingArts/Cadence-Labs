#!/usr/bin/env python3
"""Official judge-level recaps from CompetitionSuite.

CompetitionSuite is the platform DCI's own recaps are generated from, so its
data is authoritative and identical to dci.org's — but it is reachable from
the cloud even when dci.org Cloudflare-blocks the runner. This backfills the
caption breakdown for shows the totals-only mirrors (drum-corps.net,
downbeatdesigns) filled without recaps.

Path: the public "bridge" API lists a season's competitions with GUIDs
(GetCompetitionsBySeason — the org-scoped list is empty for the live season,
the season-scoped one is not), each GUID resolves to per-round recap URLs
(GetCompetition), and each recap page carries every judge's sub-scores.

Value encoding (verified against known-good dci.org data — DCI Central Texas
2026, 6/6 corps caption-for-caption): CompetitionSuite stores judge
sub-scores ×10 with at most one decimal (84 → 8.400), and caption/sub/totals
as-is with two or more decimals (16.80 → 16.800). Every parsed row is then
re-verified arithmetically by build_data (non-reconciling rows are dropped),
so a mis-parse can never surface as a wrong score.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import date

from common import ROOT, fetch, log, norm_space, canon_corps, slugify

PARSED = ROOT / "data" / "parsed"
DCI_ORG = "96b77ec2-333e-41e9-8d7d-806a8cbe116b"
BRIDGE = "https://bridge.competitionsuite.com/api/orgscores"

ROUND_CLASS = {
    "world class": "World Class",
    "open class": "Open Class",
    "all age": "All-Age",
    "all-age": "All-Age",
    "soundsport": "SoundSport",
    "international": "International",
    "exhibition": "Exhibition",
}

_ANCHOR = re.compile(
    r"<td class='content topBorder rightBorderDouble'>([^<]+)</td>\s*"
    r"<td class='content topBorder rightBorderDouble'[^>]*>([^<]*,\s*[A-Z]{2})</td>")
# each score sits in a wrapper <td> whose class names the column's role:
#   verified / subcaptionTotal / categoryTotal ... = a real judge score, a
#   judge's caption total, or a block (GE/Visual/Music) total — all kept;
#   captionTotal = the redundant combined total a *doubled* sub-caption panel
#   inserts, which isn't in the sheet layout build_data reconciles against, so
#   it's dropped. (subcaptionTotal contains the substring "captionTotal" — the
#   match is on whole class words, not a substring.)
_SCORE_CELL = re.compile(
    r"<td class='([^']*)'[^>]*>\s*(<table class='scoreTable'.*?</table>)\s*</td>", re.S)
_NUM = re.compile(r"data-translate-number='([^']*)'")
_RANK = re.compile(r"class='content rank'>([^<]*)<")


def _bridge(endpoint: str):
    txt = fetch(f"{BRIDGE}/{endpoint}", force=True, accept_json=True) or \
          fetch(f"{BRIDGE}/{endpoint}", accept_json=True)
    if not txt:
        return None
    txt = txt.strip()
    if not txt.startswith("{") and not txt.startswith("["):  # strip any jQuery(...) wrapper
        i, j = txt.find("("), txt.rfind(")")
        if 0 <= i < j:
            txt = txt[i + 1:j]
    try:
        return json.loads(txt)
    except Exception:
        return None


def _atom(raw: str, rank: str) -> str:
    raw = raw.strip()
    if raw in ("", "--", "-"):
        return "0"
    dec = len(raw.split(".")[1]) if "." in raw else 0
    val = float(raw) / 10 if dec <= 1 else float(raw)
    return f"{val:.3f}" + (f" {rank}" if rank and rank.isdigit() else "")


_HDR_CELL = re.compile(r"<td\b([^>]*)>(.*?)</td>", re.S)
# the groups row is wrapped in a nested scoring <table>; strip that opener so
# the round-name / corps cells (rowspan=4) are read as their own cells and not
# merged into the wrapper <td>.
_HDR_WRAP = re.compile(r"^<tr\b[^>]*>\s*<td\b[^>]*>\s*<table\b[^>]*>\s*<tr\b[^>]*>", re.S)
_TR = re.compile(r"<tr\b.*?</tr>", re.S)


def _hdr_cells(row: str) -> list[tuple[str, int, int]]:
    """(text, colspan, rowspan) for each <td> in a header row."""
    out = []
    for m in _HDR_CELL.finditer(_HDR_WRAP.sub("", row)):
        attrs, inner = m.group(1), m.group(2)
        cs = re.search(r"colspan=['\"]?(\d+)", attrs)
        rs = re.search(r"rowspan=['\"]?(\d+)", attrs)
        txt = norm_space(re.sub(r"<[^>]+>", " ", inner).replace("\xa0", " ").replace("&nbsp;", " "))
        out.append((txt, int(cs.group(1)) if cs else 1, int(rs.group(1)) if rs else 1))
    return out


def parse_recap_groups(html: str):
    """Structured recap header, same shape build_data._recap_header emits:
    [{"n": group, "subs": [{"n": sub, "j": judge, "cols": [labels]}]}].

    The sheet's four header rows (groups / subs / judges / leaf-columns) sit
    just before <!--PerformancesStart-->. They're aligned at leaf-column
    granularity (colspans expanded). One build_data "sub" is emitted per JUDGE
    panel — so a double-judged sub-caption yields two subs (matching the row
    atoms, which keep each judge's sub-total and drop the doubled panel's
    combined captionTotal). Group-total (&nbsp;) spacer columns and the
    Penalties column are not subs — build_recaps accounts for them with its
    per-group +1 and trailing +3, and re-verifies every row's atom count
    against this structure, so a mis-parse drops rows rather than lie."""
    idx = html.find("<!--PerformancesStart-->")
    if idx < 0:
        a = _ANCHOR.search(html)
        idx = a.start() if a else len(html)
    trs = _TR.findall(html[:idx])
    if len(trs) < 4:
        return None
    grow, srow, jrow, crow = trs[-4:]
    gcells, scells, jcells, ccells = (_hdr_cells(r) for r in (grow, srow, jrow, crow))

    def _expand(cells):
        out = []
        for txt, cs, _rs in cells:
            out.extend([txt] * cs)
        return out

    # caption groups only: the named, non-rowspan cells (GE/Visual/Music).
    # Round-name/corps/Sub Total/Total are rowspan=4; the Penalties spacer is
    # blank — all excluded here.
    group_specs = [(txt, cs) for txt, cs, rs in gcells if rs == 1 and txt]
    if not group_specs:
        return None
    sub_by_leaf = _expand(scells)
    leaf_labels = _expand(ccells)
    L = len(leaf_labels)
    group_by_leaf = []
    for gname, gspan in group_specs:
        group_by_leaf.extend([gname] * gspan)
    group_by_leaf.extend([""] * (L - len(group_by_leaf)))   # penalty tail

    groups, li = [], 0
    for jname, jspan, _rs in jcells:
        labels = leaf_labels[li:li + jspan]
        g = group_by_leaf[li] if li < len(group_by_leaf) else ""
        sname = sub_by_leaf[li] if li < len(sub_by_leaf) else ""
        li += jspan
        if not jname or not g:      # total/penalty spacer columns: not a sub
            continue
        cols = [x for x in labels if x.upper() != "TOT"]
        if not groups or groups[-1]["n"] != g:
            groups.append({"n": g, "subs": []})
        groups[-1]["subs"].append({"n": sname, "j": jname, "cols": cols})
    return groups or None


def parse_recap(html: str) -> list[dict]:
    """CompetitionSuite recap page -> rows [{corps, total, cells:[atoms]}]."""
    anchors = list(_ANCHOR.finditer(html))
    rows = []
    for k, a in enumerate(anchors):
        corps = canon_corps(a.group(1))
        if not corps:
            continue
        end = anchors[k + 1].start() if k + 1 < len(anchors) else len(html)
        atoms = []
        for cell in _SCORE_CELL.finditer(html[a.end():end]):
            if "captionTotal" in cell.group(1).split():
                continue  # doubled-panel combined total — not part of the layout
            nm = _NUM.search(cell.group(2))
            if not nm:
                continue
            rk = _RANK.search(cell.group(2))
            atoms.append(_atom(nm.group(1), rk.group(1).strip() if rk else ""))
        if not atoms:
            continue
        nums = [float(x.split()[0]) for x in atoms if x != "0"]
        rows.append({"corps": corps, "total": max(nums) if nums else 0.0, "cells": atoms})
    return rows


def _season_guid(year: int) -> str | None:
    seasons = _bridge(f"GetSeasons/jsonp?organization={DCI_ORG}") or []
    for s in seasons:
        if norm_space(str(s.get("name"))) == str(year):
            return s.get("seasonGuid")
    return None


def _competitions(season_guid: str) -> list[dict]:
    d = _bridge(f"GetCompetitionsBySeason/jsonp?season={season_guid}") or {}
    return d.get("competitions") or []


def _recent_competitions(comps: list[dict], days: int | None,
                         today: date | None = None) -> list[dict]:
    """Limit a live pass to recently completed shows.

    CompetitionSuite's season list is authoritative but can contain dozens of
    completed events. The show-night watcher already knows that a source
    changed, so re-fetching every competition only adds latency. Keep the
    normal scraper's all-season behavior when ``days`` is None.
    """
    if days is None:
        return comps
    today = today or date.today()
    selected = []
    for comp in comps:
        raw = (comp.get("competitionDate") or "")[:10]
        try:
            age = (today - date.fromisoformat(raw)).days
        except ValueError:
            continue
        if 0 <= age <= days:
            selected.append(comp)
    return selected


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", norm_space(s or "").lower())


_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]


def _date_display(iso: str) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", iso or "")
    if not m:
        return ""
    y, mo, d = m.group(1), int(m.group(2)), int(m.group(3))
    return f"{_MONTHS[mo]} {d}, {y}"


def _ev_iso_date(ev: dict) -> str | None:
    """ISO date for an existing event — from its `date`, else parsed from
    `date_display`. Lets us tell same-name shows on different days apart so a
    multi-day event (e.g. Eastern Classic Fri & Sat) doesn't collapse to one
    URL key."""
    d = ev.get("date")
    if d:
        return str(d)[:10]
    m = re.match(r"([A-Za-z]+)\s+(\d+),\s*(\d{4})", ev.get("date_display") or "")
    if m and m.group(1) in _MONTHS:
        return f"{m.group(3)}-{_MONTHS.index(m.group(1)):02d}-{int(m.group(2)):02d}"
    return None


def _canonical_urls() -> dict[str, str]:
    """normalized event name -> dci.org final-scores URL, from the calendar,
    so a show CompetitionSuite has lines up with dci.org's own key (and
    upgrades in place with no duplicate once the wall lifts)."""
    up = PARSED / "dci_upcoming.json"
    out = {}
    if up.exists():
        for e in json.loads(up.read_text()):
            m = re.search(r"/events/([^/]+)/?", e.get("url") or "")
            if m and e.get("name"):
                out[_norm(e["name"])] = f"https://www.dci.org/scores/final-scores/{m.group(1)}/"
    return out


_CLASS_ORDER = {"World Class": 0, "Open Class": 1, "All-Age": 2,
                "SoundSport": 3, "International": 4, "Exhibition": 5}


def _round_classes(detail: dict):
    """GetCompetition rounds -> (classes[results], recap[caption rows]),
    ordered World / Open / All-Age to match the rest of the app."""
    classes, recap = [], []
    for rnd in detail.get("rounds") or []:
        cls = ROUND_CLASS.get(norm_space(rnd.get("name") or "").lower(), rnd.get("name") or "Results")
        results = []
        for p in rnd.get("performances") or []:
            corps = canon_corps(p.get("name") or "")
            if corps and p.get("score") is not None:
                results.append({"place": p.get("rank"), "corps": corps, "score": float(p["score"])})
        results.sort(key=lambda r: (r["place"] is None, r["place"] if r["place"] is not None else 0))
        if results:
            classes.append({"class": cls, "results": results})
        url = (rnd.get("fullRecapUrl") or "").replace("http://", "https://")
        if url:
            html = fetch(url, force=True) or fetch(url)
            rows = parse_recap(html) if html else []
            if rows:
                # groups: the full judge/column header so build_recaps can
                # render sub-columns (Rep/Perf, Cont/Achv…) like dci.org recaps,
                # not just totals. None on an unrecognized sheet -> falls back.
                groups = parse_recap_groups(html) if html else None
                recap.append({"class": cls, "captions": [], "groups": groups, "rows": rows})
    ordr = lambda x: _CLASS_ORDER.get(x["class"], 9)
    classes.sort(key=ordr)
    recap.sort(key=ordr)
    return classes, recap


def _has_results(ev: dict) -> bool:
    return any(c.get("results") for c in ev.get("classes") or [])


def main(year: int | None = None, recent_days: int | None = None,
         sync_results: bool = False) -> int:
    if year is None:
        year = date.today().year
    events_path = PARSED / "dci_events.json"
    if not events_path.exists():
        return 0
    events = json.loads(events_path.read_text())
    by_url = {e["url"]: e for e in events}
    canon = _canonical_urls()

    season = _season_guid(year)
    if not season:
        log(f"compsuite: no season GUID for {year} — skipping")
        return 0
    all_comps = _competitions(season)
    comps = _recent_competitions(all_comps, recent_days)
    if recent_days is None:
        log(f"compsuite: {len(comps)} competitions listed for {year}")
    else:
        log(f"compsuite live: checking {len(comps)}/{len(all_comps)} competitions "
            f"from the last {recent_days} day(s)")

    created = filled = updated = recapped = 0
    for comp in comps:
        comp_date = (comp.get("competitionDate") or "")[:10]
        name = norm_space(comp.get("name"))
        url = canon.get(_norm(name)) or \
            f"https://www.dci.org/scores/final-scores/{year}-{slugify(name)}/"
        cur = by_url.get(url)
        # Multi-day, same-name show (e.g. DCI Eastern Classic Fri & Sat): if the
        # URL is already held by a DIFFERENT date, disambiguate with the date so
        # the two days keep separate keys instead of clobbering each other.
        if cur is not None:
            cd = _ev_iso_date(cur)
            if comp_date and cd and cd != comp_date:
                url = url.rstrip("/") + f"-{comp_date}/"
                cur = by_url.get(url)
        # dci.org's OWN recap is the authoritative, final form — never touch it.
        # (A fallback-created event carries a "source" tag; a dci.org one does
        # not, so this only protects genuine dci.org scrapes.)
        if (cur is not None and cur.get("recap") and not cur.get("source")
                and not sync_results):
            continue

        detail = _bridge(f"GetCompetition/jsonp?competition={comp['competitionGuid']}")
        if not detail:
            continue
        classes, recap = _round_classes(detail)
        if not classes and not recap:
            continue
        slug = url.rstrip("/").rsplit("/", 1)[-1]

        if cur is None:
            # brand-new show no other source has yet — create it in full
            by_url[url] = {
                "url": url, "slug": slug, "year": year, "name": name,
                "date": comp_date,
                "date_display": _date_display(comp.get("competitionDate")),
                "location": comp.get("location") or "",
                "recap_url": f"https://www.dci.org/scores/recap/{slug}/",
                "classes": classes, "recap": recap, "source": "competitionsuite",
            }
            created += 1
            top = classes[0]["results"][0] if classes and classes[0]["results"] else None
            lead = f" — {top['corps']} {top['score']}" if top else ""
            log(f"  + created {name} ({comp_date}){lead} [{len(classes)} class(es)]")
        elif sync_results:
            # The live watcher is triggered by a changed source. CompetitionSuite
            # is DCI's scoring platform, so use its current classes immediately,
            # including partial rounds, while preserving a richer official DCI
            # recap if one is already attached to the event.
            changed = False
            if classes and classes != cur.get("classes"):
                cur["classes"] = classes
                changed = True
            if recap and recap != cur.get("recap") and (cur.get("source") or not cur.get("recap")):
                cur["recap"] = recap
                changed = True
            if changed:
                updated += 1
                ncorps = sum(len(c.get("results") or []) for c in classes)
                log(f"  ~ live synced {name} ({comp_date}) → {len(classes)} class(es), {ncorps} corps")
        elif cur.get("source"):
            # a fallback-filled show — RE-SYNC from CompetitionSuite every run so
            # a partial show completes: shows post in stages (Open Class performs
            # and posts before World Class), and the earlier run may have caught
            # only the first round. CompetitionSuite is authoritative, so trust
            # its current, fuller picture.
            changed = False
            if classes and classes != cur.get("classes"):
                cur["classes"] = classes
                changed = True
            if recap and recap != cur.get("recap"):
                cur["recap"] = recap
                changed = True
            if changed:
                updated += 1
                ncorps = sum(len(c.get("results") or []) for c in classes)
                log(f"  ~ synced {name} ({comp_date}) → {len(classes)} class(es), {ncorps} corps")
        elif not _has_results(cur):
            cur["classes"] = classes or cur.get("classes")
            if recap:
                cur["recap"] = recap
            filled += 1
            log(f"  + filled {name} ({comp_date}) results+recap from CompetitionSuite")
        elif not cur.get("recap") and recap:
            cur["recap"] = recap  # dci.org results with no recap yet — add captions
            recapped += 1
            log(f"  + recap for {name} ({comp_date})")

    if created or filled or updated or recapped:
        merged = sorted(by_url.values(),
                        key=lambda e: (e.get("year") or 0, e.get("date_display") or "", e.get("name") or ""))
        events_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1))
        log(f"compsuite: +{created} created, {filled} filled, {updated} synced, {recapped} recapped → {events_path}")
    else:
        log("compsuite: nothing new")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("year", nargs="?", type=int, default=date.today().year)
    parser.add_argument("--recent-days", type=int, default=None,
                        help="only fetch competitions completed within DAYS")
    parser.add_argument("--sync-results", action="store_true",
                        help="update recent official-source score rows from CompetitionSuite")
    args = parser.parse_args()
    raise SystemExit(main(args.year, args.recent_days, args.sync_results))
