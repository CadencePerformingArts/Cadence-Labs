#!/usr/bin/env python3
"""Derive the Cadence family engine (docs/family/app.js) from the DCI app
(docs/app.js), plus a family copy of wrapped.js for share cards.

The DCI app is never modified. Family instances (the three WGI activities)
load docs/family/app.js with a `window.APP_CFG` config that supplies class
lists, terminology and a storage namespace, so every instance behaves like
the DCI app with its own data.

Each transform asserts its anchor exists — if docs/app.js drifts, this
script fails loudly (and so does the deploy) instead of silently shipping a
broken family engine. When an anchor dies, re-anchor it against the new
source; never loosen an assertion into a no-op.

    python3 scripts/build_family_engine.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "app.js"
OUT_DIR = ROOT / "docs" / "family"

HEADER = """/* Cadence family engine — GENERATED from docs/app.js by
   scripts/build_family_engine.py. Do not edit by hand; edit the DCI app or
   the build script and regenerate. Instances configure via window.APP_CFG:
   { appName, root, ns, board, captions, classOrder, combinable,
     terms:{singular,plural,a}, eventsTitle } */
"""

FAM_BOOTSTRAP = """  // --- Cadence family config (absent on the DCI app, set by instances) ---
  const FAM = window.APP_CFG || null;
  const NS = k => (FAM ? FAM.ns : "") + k;
  const TERM = FAM ? FAM.terms : { singular: "corps", plural: "corps", a: "a corps" };
  // Does this app publish judge-level caption sheets? The DCI app always
  // does; a family instance says so in its config (WGI ships captions:false
  // because WGI's sheets are behind its directors-only portal). Every
  // caption surface — the Stats sub-tab, the corps-profile tile, the
  // Database dataset, the per-event recap fetch — is gated on this, so a
  // captionless app never shows a control that leads nowhere.
  const CAPS = !FAM || !!FAM.captions;
"""

SETTINGS_INJECT = """
    // family pages: drop the cards whose feature only exists on the DCI app.
    // Score alerts need a live scores feed and the push relay's per-corps
    // registration (neither exists for a family circuit), and the install
    // prompt is wired by install.js, which family shells don't load — so
    // both cards would sit there doing nothing.
    if (FAM) app.querySelectorAll(".setcard").forEach(c => {
      const t = ((c.querySelector("h2") || {}).textContent) || "";
      if (/Add to Home Screen|Notifications|Prediction/i.test(t)) c.remove();
    });
"""


def sub_once(src: str, old: str, new: str, label: str, count: int = 1) -> str:
    found = src.count(old)
    assert found == count, f"{label}: expected {count} occurrence(s) of anchor, found {found}: {old[:80]!r}"
    return src.replace(old, new)


def main() -> None:
    js = SRC.read_text()

    # bootstrap + namespacing helpers
    js = sub_once(js, "  const cache = new Map();",
                  "  const cache = new Map();\n" + FAM_BOOTSTRAP, "bootstrap")

    # class systems from config
    js = sub_once(
        js,
        'const CLASS_ORDER = ["World Class", "Open Class", "All-Age", "International"];',
        'const CLASS_ORDER = FAM ? FAM.classOrder : ["World Class", "Open Class", "All-Age", "International"];',
        "class order")
    js = sub_once(
        js,
        'const COMBINABLE_SCORE_CLASSES = new Set(["World Class", "Open Class"]);',
        'const COMBINABLE_SCORE_CLASSES = new Set(FAM ? (FAM.combinable || []) : ["World Class", "Open Class"]);',
        "combinable")
    js = sub_once(
        js,
        'const TYPE_FAMILIES = ["World Class", "Open Class", "All-Age", "International"];',
        'const TYPE_FAMILIES = FAM ? FAM.classOrder : ["World Class", "Open Class", "All-Age", "International"];',
        "type families")

    # storage namespacing — literal keys
    pat = re.compile(
        r'(localStorage|sessionStorage)\.(getItem|setItem|removeItem)\(\s*"'
        r'(dt-[a-z]+|cad-favs|cad-preds|cad-pins|cad-notify-preds|cmp-corps|cmp-years|cad-shows-f)"')
    js, n = pat.subn(lambda m: f'{m.group(1)}.{m.group(2)}(NS("{m.group(3)}")', js)
    assert n >= 14, f"storage namespacing: only {n} matches"
    # concatenated per-tab keys
    js = sub_once(js, 'sessionStorage.setItem("cad-last-" + sec, hash)',
                  'sessionStorage.setItem(NS("cad-last-" + sec), hash)', "cad-last set")
    js = sub_once(js, 'sessionStorage.getItem("cad-last-" + r)',
                  'sessionStorage.getItem(NS("cad-last-" + r))', "cad-last get")
    # brand-click reset uses a key list
    js = sub_once(js, '["dt-class", "dt-corpsclass"].forEach(k => localStorage.removeItem(k));',
                  '["dt-class", "dt-corpsclass"].forEach(k => localStorage.removeItem(NS(k)));', "brand reset ls")
    js = sub_once(js, '''["cmp-corps", "cmp-years", "cad-shows-f",
      "cad-last-rankings", "cad-last-events", "cad-last-corps", "cad-last-data"]
      .forEach(k => sessionStorage.removeItem(k));''',
                  '''["cmp-corps", "cmp-years", "cad-shows-f",
      "cad-last-rankings", "cad-last-events", "cad-last-corps", "cad-last-data"]
      .forEach(k => sessionStorage.removeItem(NS(k)));''', "brand reset ss")

    # ---- live scoring: a family app has no live feed ----
    # LIVE.refresh polls the CURRENT calendar year's season file and the
    # upcoming feed every 30 s. No family circuit publishes scores as they
    # land, and an app whose only season is next year's schedule would ask
    # for a seasons/<this year>.json that will never exist — a guaranteed
    # 404 on every Shows visit. Skip the fetches; every LIVE lookup already
    # answers false against an empty cache.
    js = sub_once(
        js,
        """      const today = etToday();
      let up = [], season = null;
      try { up = await data("upcoming.json"); } catch (e) {}
      try { season = await data(`seasons/${+today.slice(0, 4)}.json`); } catch (e) {}""",
        """      const today = etToday();
      let up = [], season = null;
      if (!FAM) {   // family circuits publish no live-scoring feed
        try { up = await data("upcoming.json"); } catch (e) {}
        try { season = await data(`seasons/${+today.slice(0, 4)}.json`); } catch (e) {}
      }""",
        "live feed skip")

    # ---- first-run onboarding ----
    # "Who do you follow?" builds its chips from rankings.json. A family app
    # with no published scores has an empty standings block, which used to
    # make Settings › Choose favorites open nothing at all. Fall back to the
    # ensemble index so the control always does something; favorites still
    # matter there (they highlight rows on the championship board).
    js = sub_once(
        js,
        "      if (!groups.length) { if (!replay) markSeen(); return; }",
        """      if (!groups.length && FAM) {
        // no standings (no published score feed) — offer the whole roster
        try {
          const roster = await data("corps_index.json");
          if (roster && roster.length) {
            groups.push({ cls: "All " + TERM.plural, rows: roster.map(c => ({ corps: c.name })) });
          }
        } catch (e) {}
      }
      if (!groups.length) { if (!replay) markSeen(); return; }""",
        "onboarding roster fallback")
    js = sub_once(
        js,
        '<p class="ob-sub">Star your corps — the scoreboard and score alerts get personalized around them.</p>',
        '<p class="ob-sub">${FAM ? "Star your " + TERM.plural + " — they lead every board and table in this app."'
        ' : "Star your corps — the scoreboard and score alerts get personalized around them."}</p>',
        "onboarding sub copy")
    # ...but never as an unsolicited first-visit modal on a secondary app.
    js = sub_once(
        js,
        "    function maybeShow() {\n      if (!storageOK || seen()) return;",
        "    function maybeShow() {\n"
        "      if (FAM) return;   // secondary apps: reachable from Settings, never a first-visit popup\n"
        "      if (!storageOK || seen()) return;",
        "onboarding no auto-show")

    # ---- captions: hide every surface when the app publishes no sheets ----
    # stats hub: no captions tab; #/data lands on Compare
    js = sub_once(
        js,
        'const DATA_SUBS = [["captions", "Captions"], ["compare", "Compare"], ["champions", "Champions"], ["records", "Records"], ["database", "Database"]];',
        'const DATA_SUBS = (CAPS ? [["captions", "Captions"]] : []).concat('
        '[["compare", "Compare"], ["champions", "Champions"], ["records", "Records"], ["database", "Database"]]);',
        "data subs")
    js = sub_once(js, '[/^#\\/(?:stats|data)$/, () => { location.replace("#/captions"); }],',
                  '[/^#\\/(?:stats|data)$/, () => { location.replace(CAPS ? "#/captions" : "#/compare"); }],',
                  "data route")
    js = sub_once(
        js,
        "[/^#\\/captions(?:\\?(.*))?$/, (m, st) => viewCaptions(m[1], st)],",
        "[/^#\\/captions(?:\\?(.*))?$/, (m, st) => { if (!CAPS) { location.replace(\"#/compare\"); return; } return viewCaptions(m[1], st); }],",
        "captions family redirect")
    # corps profile: the fourth stat tile deep-links into the captions view.
    # Without sheets that tile lands on a redirect back to Compare — a tile
    # that dead-ends. Drop it; the tile grid is auto-fill and reflows to 3.
    js = sub_once(
        js,
        """        <a class="tile click" href="#/captions?corps=${encodeURIComponent(detail.name)}">
          <div class="label">Caption Scores</div><div class="value">GE · VIS · MUS</div>
          <div class="sub">judge-by-judge breakdowns →</div></a>""",
        """        ${!CAPS ? "" : `<a class="tile click" href="#/captions?corps=${encodeURIComponent(detail.name)}">
          <div class="label">Caption Scores</div><div class="value">GE · VIS · MUS</div>
          <div class="sub">judge-by-judge breakdowns →</div></a>`}""",
        "corps caption tile")
    # event page: skip the recap + caption sheet fetches (both 404 without a
    # captions dataset, and the page renders identically without them)
    js = sub_once(
        js,
        "      if (+year >= 2013) {",
        "      if (+year >= 2013 && CAPS) {",
        "event captions fetch")
    # Database: drop the "Caption Scores" dataset from the picker
    js = sub_once(
        js,
        "      options: Object.entries(DB_SETS).map(([k, v]) => ({ value: k, label: v.label })),",
        "      options: Object.entries(DB_SETS).filter(([k]) => CAPS || k !== \"captions\")\n"
        "        .map(([k, v]) => ({ value: k, label: v.label })),",
        "database caption dataset")

    # ---- Shows page: no news feed, no off-season calendar ----
    # Both are DCI-pipeline files (news.json, offseason.json). A family app
    # publishes neither, and renderNews(null) already renders nothing — but
    # the fetches themselves would log a 404 on every visit to Shows.
    js = sub_once(
        js,
        '      const off = await data("offseason.json").catch(() => []);',
        '      const off = FAM ? [] : await data("offseason.json").catch(() => []);',
        "offseason skip")
    js = sub_once(
        js,
        '      news = await data("news.json").catch(() => null);',
        '      news = FAM ? null : await data("news.json").catch(() => null);',
        "news skip")

    # ---- About: one canonical page, on the DCI app ----
    # viewAbout is written about DCI (its sources, its privacy posture).
    # Nothing on a family page links to it, but a typed/shared #/about must
    # not render DCI's copy under a WGI banner — send it home instead.
    js = sub_once(
        js,
        "  function viewAbout() {\n    setNav(\"\");",
        "  function viewAbout() {\n    setNav(\"\");\n"
        "    // the About page is DCI's; family apps hand off to the canonical copy\n"
        "    if (FAM) { location.href = (FAM.root || \".\") + \"/#/about\"; return; }",
        "about handoff")

    # Alternate scoreboards. DCI's standings board assumes corps meet each
    # other repeatedly all season (10 performances each, 92% with 3+), which
    # makes trend lines meaningful. That premise fails for a circuit that
    # publishes no season scores at all — those apps declare a board shape
    # and render a purpose-built module (docs/family/board.js) instead.
    js = sub_once(
        js,
        """  async function viewRankings(qs, stale) {
    setNav("rankings");""",
        """  async function viewRankings(qs, stale) {
    setNav("rankings");
    if (FAM && FAM.board && FAM.board !== "trend" && window.CadBoard) {
      return CadBoard.render({
        app, data, stale, shape: FAM.board, cfg: FAM,
        helpers: { esc, h, score3, corpsLink, corpsLogo, sortClasses, fmtDate2, FAVS, ensureLogos },
      });
    }""",
        "board shape hook")

    # ---- terminology: user-visible strings ----
    # NOTE: several targets live in PLAIN strings, not template literals —
    # those must use concatenation, never ${...} (which would render raw).
    pairs = [
        ("'<li class=\"pr-hint\">Tap a corps below to start ranking…</li>'",
         "'<li class=\"pr-hint\">Tap ' + TERM.a + ' below to start ranking…</li>'", 1),
        ("} corps`,", "} ${TERM.plural}`,", 1),
        ('"Pick corps to chart…"', '"Pick " + TERM.plural + " to chart…"', 2),
        ("each corps' most recent score", "each ${TERM.singular}'s most recent score", 1),
        ("\"<h2>Closest Battle</h2><div class='empty'>Needs two corps within striking distance.</div>\"",
         "\"<h2>Closest Battle</h2><div class='empty'>Needs two \" + TERM.plural + \" within striking distance.</div>\"", 1),
        ("pick several corps and seasons — every corps-season gets its own line",
         "pick several ${TERM.plural} and seasons — every ${TERM.singular}-season gets its own line", 1),
        ("Select as many corps as you like — each corps-season draws its own line,",
         "Select as many ${TERM.plural} as you like — each ${TERM.singular}-season draws its own line,", 1),
        ('"Add corps — pick as many as you like…"', '"Add " + TERM.plural + " — pick as many as you like…"', 1),
        ("Pick corps to compare — this season is already selected",
         "Pick ${TERM.plural} to compare — this season is already selected", 1),
        ("} corps-season lines — trim the selection", "} ${TERM.singular}-season lines — trim the selection", 1),
        ('"Pick a corps…"', '"Pick " + TERM.a + "…"', 2),
        ("Choose any corps above to see season charts, the full performance log, and championship titles — back to 1972.",
         "Choose any ${TERM.singular} above to see season charts, the full performance log, and championship titles${FAM ? \"\" : \" — back to 1972\"}.", 1),
        ("No scores on record for this corps yet.", "No scores on record for this ${TERM.singular} yet.", 1),
        ("Browse all corps →", "Browse all ${TERM.plural} →", 1),
        ("Share this corps' season card", "Share this ${TERM.singular}'s season card", 1),
        ("compare vs other corps →", "compare vs other ${TERM.plural} →", 1),
        ("Change from this corps' previous show that season",
         "Change from this ${TERM.singular}'s previous show that season", 1),
        ("${ev.lineup.length} corps</span>", "${ev.lineup.length} ${TERM.plural}</span>", 1),
        ("${c.results.length} corps</span>", "${c.results.length} ${TERM.plural}</span>", 1),
        ('<h1 class="page">Shows ${yearPickerHtml(year)} <span',
         '<h1 class="page">${FAM ? FAM.eventsTitle : "Shows"} ${yearPickerHtml(year)} <span', 1),
        ('· any corps, any seasons', '· any ${TERM.singular}, any seasons', 1),
        # onboarding sheet, Database search box, Settings › Favorites summary —
        # all three are reachable on a family app
        ('placeholder="Search corps…" aria-label="Search corps"',
         'placeholder="Search ${TERM.plural}…" aria-label="Search ${TERM.plural}"', 1),
        ('placeholder="Search event or corps…"', 'placeholder="Search event or ${TERM.singular}…"', 1),
        ('"Star corps to pin them on the Scoreboard and lead your score alerts."',
         '(FAM ? "Star " + TERM.plural + " to pin them to the top of every board and table."'
         ' : "Star corps to pin them on the Scoreboard and lead your score alerts.")', 1),
        (' — starred everywhere, first in score alerts.`',
         ' — starred everywhere${FAM ? "" : ", first in score alerts"}.`', 1),
        ('· the record book, 1972–today', '· the record book${FAM ? "" : ", 1972–today"}', 1),
    ]
    for old, new, count in pairs:
        js = sub_once(js, old, new, f"term: {old[:40]}", count)

    # table column headers and the ensembles page title
    js, n = re.subn(r'>Corps<', '>${TERM_TH}<', js)
    assert n == 13, f"'Corps' table headers: {n}"

    # Two 'corps' that the >Corps< regex cannot reach, both shipped on every
    # WGI app before this was caught:
    #   1. the Ensembles-page sub-heading, whose own body text underneath it
    #      already read "Choose any ensemble above" — the card disagreed with
    #      itself. (The old transform anchored on '>Pick a corps</h2>'; the new
    #      app.js capitalises it, so the anchor silently matched nothing.)
    #   2. the Database column list, which is a plain JS array rather than
    #      markup — and doubles as the CSV export header, so the downloaded
    #      file said Corps too, next to filters reading "All ensembles".
    js = sub_once(js, '<h2 style="margin:10px 0 6px">Pick a Corps</h2>',
                  '<h2 style="margin:10px 0 6px">Pick ${TERM.a}</h2>',
                  "pick-one heading")
    js = sub_once(js, '"Year", "Date", "Event", "Corps", "Class", "Place", "Score"',
                  '"Year", "Date", "Event", TERM_TH, "Class", "Place", "Score"',
                  "database column list")
    js = sub_once(
        js,
        'const NS = k => (FAM ? FAM.ns : "") + k;',
        'const NS = k => (FAM ? FAM.ns : "") + k;\n'
        '  const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);',
        "cap helper")
    # >Corps< sites are template literals except the static h1 — make that one a template
    js = sub_once(js, '<h1 class="page" id="corpsPageTitle">${TERM_TH}</h1>',
                  '<h1 class="page" id="corpsPageTitle">${cap1(TERM.singular === "corps" ? "corps" : TERM.plural)}</h1>',
                  "corps page title")
    # define TERM_TH after TERM exists
    js = sub_once(
        js,
        'const TERM = FAM ? FAM.terms : { singular: "corps", plural: "corps", a: "a corps" };',
        'const TERM = FAM ? FAM.terms : { singular: "corps", plural: "corps", a: "a corps" };\n'
        '  const TERM_TH = FAM ? cap1(FAM.terms.singular) : "Corps";',
        "TERM_TH")
    # the ensemble pickers (Compare and the Ensembles tab) hint at each
    # entry's span of seasons. An app whose index has no scored seasons yet
    # stores nulls there — printed straight, every option read "null".
    js = sub_once(
        js,
        '.map(c => ({ value: c.slug, label: c.name, hint: c.first === c.last ? String(c.first) : `${c.first}–${c.last}` }));',
        '.map(c => ({ value: c.slug, label: c.name,\n'
        '        hint: c.first == null ? "" : c.first === c.last ? String(c.first) : `${c.first}–${c.last}` }));',
        "corps picker hint", 2)

    # corps hero: the season share card is built from a season's results, so
    # an ensemble with no published results has nothing to share — the button
    # asked for seasons/undefined.json (a 404) and then silently did nothing.
    js = sub_once(
        js,
        '          <button id="corpCard" class="ch-btn" title="Share this ${TERM.singular}\'s season card">${SHARE_SVG} Share</button>',
        '          ${years.length ? `<button id="corpCard" class="ch-btn" title="Share this ${TERM.singular}\'s season card">${SHARE_SVG} Share</button>` : ""}',
        "share card button guard")

    # corps hero: the kicker above the name reads the class of the corps'
    # latest performance, and falls back to the literal "Drum Corps". Neither
    # fits an app whose ensembles may hold titles but no published results —
    # fall back to the class they last won, then to the app's own noun.
    js = sub_once(
        js,
        '<div class="corpshero-kicker">${esc(primaryCls || "Drum Corps")}',
        '<div class="corpshero-kicker">${esc(primaryCls'
        ' || (titles.length ? titles.slice().sort()[titles.length - 1].replace(/^\\d{4}\\s+/, "") : "")'
        ' || (FAM ? cap1(TERM.plural) : "Drum Corps"))}',
        "hero kicker fallback")
    # "0 season on record" — a DCI corps always has at least one, an ensemble
    # known only from the record book has none
    js = sub_once(
        js,
        '`${years.length} season${years.length > 1 ? "s" : ""} on record`',
        '`${years.length} season${years.length === 1 ? "" : "s"} on record`',
        "seasons plural")

    # profile card: only render it when there is something to say. A family
    # app's profiles.json often carries nothing but a generated monogram
    # (corpsLogo reads `img` for every avatar in the app) — that must not
    # paint an empty card with a lone logo under the corps hero.
    js = sub_once(
        js,
        "    const profHtml = prof ? h`",
        "    const profHtml = (prof && (prof.summary || prof.founded || prof.location\n"
        "      || prof.division || prof.director || prof.website || prof.wiki)) ? h`",
        "profile card guard")

    # championship hub: family apps lead the Champions tab with the reigning
    # champion of every class (tap-through to profiles)
    js = sub_once(
        js,
        '''<div class="chartwrap" id="champChart"></div>
      </div></div>`;''',
        '''<div class="chartwrap" id="champChart"></div>
      </div></div>`;
    if (FAM) (async () => {
      try {
        const ch = await data("champions.json");
        const years = Object.keys(ch).sort();
        const latest = years[years.length - 1];
        if (!latest || !ch[latest]) return;
        const ordered = CLASS_ORDER.filter(c => ch[latest][c])
          .concat(Object.keys(ch[latest]).filter(c => !CLASS_ORDER.includes(c)));
        if (!ordered.length) return;
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `<h2>Reigning Champions <span class="sub">${esc(String(latest))} titles</span></h2>
          <div class="champ-grid">` + ordered.map(c => {
            const w = ch[latest][c];
            const score = w.score != null ? `<span class="champ-tile-s">${esc(String(w.score))}</span>` : "";
            return `<a class="champ-tile" href="#/corps/${slugOf(w.corps)}">${corpsLogo(w.corps, 36)}
              <span class="champ-tile-t"><span class="champ-tile-cls">${esc(c)}</span>
              <b>${esc(w.corps)}</b>${score}</span></a>`;
          }).join("") + `</div>`;
        const h1 = app.querySelector("h1.page");
        if (h1 && !stale()) h1.after(card);
      } catch (e) {}
    })();''',
        "reigning champions hub")

    # per-tab memory: #/data's front page moves when there is no captions tab
    js = sub_once(
        js,
        'const NAV_DEFAULT = { rankings: "#/", events: "#/events", corps: "#/corps", data: "#/captions" };',
        'const NAV_DEFAULT = { rankings: "#/", events: "#/events", corps: "#/corps", data: CAPS ? "#/captions" : "#/compare" };',
        "nav defaults")

    # champions view: friendly state instead of an empty table when the
    # record book hasn't been built yet (a new app's first ingest)
    js = sub_once(
        js,
        "    // one table: every season, its champion, click through to the year\n    const clsSet = new Set();",
        "    // one table: every season, its champion, click through to the year\n"
        "    if (FAM && !Object.keys(champs || {}).length) {\n"
        "      const t = document.getElementById(\"champT\");\n"
        "      if (t) t.innerHTML = \"<tbody><tr><td class='empty'>The record book fills in with this app's first full season of data.</td></tr></tbody>\";\n"
        "      const cs = document.getElementById(\"champSub\");\n"
        "      if (cs) cs.textContent = \"\";\n"
        "      return;\n"
        "    }\n"
        "    const clsSet = new Set();",
        "champions empty guard")

    # Records' empty state returns before painting the Stats sub-nav, so a
    # reader who lands on it has no way across to Compare or Champions. On
    # the DCI app the record book is never empty; on an app still waiting for
    # its first season it is the normal state.
    js = sub_once(
        js,
        '      app.innerHTML = "<div class=\'card\'><div class=\'empty\'>The record book builds with the next data run.</div></div>";',
        '      app.innerHTML = dataSubNav("records")\n'
        '        + \'<h1 class="page">Records <span class="kicker">· the all-time book</span></h1>\'\n'
        '        + "<div class=\'card\'><div class=\'empty\'>The record book builds with the next data run.</div></div>";',
        "records empty subnav")

    # compare: default to the latest season that actually has scores — a
    # schedule-only future season (e.g. WGI 2027) must not open an empty chart
    js = sub_once(
        js,
        "if (!yearsSel.length && allYears.length) yearsSel = [Math.max(...allYears)];",
        """if (!yearsSel.length && allYears.length) {
      let pool = allYears;
      if (FAM) {
        const scored = new Set();
        idx.forEach(c => (c.series || []).forEach(sr => { if (sr[1] != null) scored.add(sr[0]); }));
        const p = allYears.filter(y => scored.has(y));
        if (p.length) pool = p;
      }
      yearsSel = [Math.max(...pool)];
    }""",
        "compare scored-year default")

    # "Show All N corps" expanders and the team-colors note
    js, n = re.subn(r'collapseRows\(([^;]*?), 5, "corps"\)', r'collapseRows(\1, 5, TERM.plural)', js)
    assert n == 3, f"collapseRows noun: {n}"
    js = sub_once(js, 'titlesMode === "years" ? "seasons" : "corps"',
                  'titlesMode === "years" ? "seasons" : TERM.plural', "titles noun")
    js = sub_once(
        js,
        "Paint Cadence in your corps' colors — or keep the classic Cadence look.",
        "Paint Cadence in ${FAM ? \"your own colors\" : \"your corps' colors\"} — or keep the classic Cadence look.",
        "team colors note")

    # plain double-quoted strings → concatenation
    js, n = re.subn(r'label: "All corps"', 'label: "All " + TERM.plural', js)
    assert n == 4, f"'All corps' labels: {n}"
    js = sub_once(
        js,
        'const emptyNote = "<div class=\'empty\'>Nothing in this slice — widen the era or corps filter.</div>";',
        'const emptyNote = "<div class=\'empty\'>Nothing in this slice — widen the era or " + TERM.singular + " filter.</div>";',
        "db empty note")

    # settings: push wiring must survive its card being removed on family apps
    js = sub_once(
        js,
        "async function paintPush() {\n      if (!window.CadPush) {",
        "async function paintPush() {\n      if (!pushStatus || !pushToggle) return;\n      if (!window.CadPush) {",
        "paintPush guard")

    # settings: strip DCI-only cards
    js = sub_once(
        js,
        '<p class="setfoot">Preferences are saved on this device. Created by Lucas Besel.</p>`;\n    if (stale()) return;',
        '<p class="setfoot">Preferences are saved on this device. Created by Lucas Besel.</p>`;\n    if (stale()) return;\n' + SETTINGS_INJECT,
        "settings inject")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "app.js").write_text(HEADER + js)

    # wrapped.js: share cards print the family app's own URL. The DCI copy
    # takes it from CadConfig; an instance carries its own in APP_CFG, which
    # wins here so a WGI card never advertises the DCI address.
    wj = (ROOT / "docs" / "wrapped.js").read_text()
    wj = sub_once(
        wj,
        'var SITE_URL = ((window.CadConfig || {}).BASE_URL',
        'var SITE_URL = ((window.APP_CFG || {}).siteUrl || (window.CadConfig || {}).BASE_URL',
        "wrapped url")
    wj = sub_once(
        wj,
        'var SITE_LABEL = (window.CadConfig || {}).BASE_LABEL',
        'var SITE_LABEL = (window.APP_CFG || {}).siteLabel || (window.CadConfig || {}).BASE_LABEL',
        "wrapped label")
    (OUT_DIR / "wrapped.js").write_text(wj)

    print(f"wrote {OUT_DIR/'app.js'} ({len(js)//1024}KB) and {OUT_DIR/'wrapped.js'}")


if __name__ == "__main__":
    main()
