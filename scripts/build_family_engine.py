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
  // Each screen says once, plainly, what this app's data does NOT cover —
  // an app with no in-season scores must explain the empty column rather
  // than just look broken. One sentence per screen, from the instance
  // config; the DCI app has full coverage and renders none of them.
  const NOTE = k => (FAM && FAM.notes && FAM.notes[k]) || "";
  const noteHtml = k => NOTE(k) ? `<div class="notice">${esc(NOTE(k))}</div>` : "";
"""

# ---------------------------------------------------------------------------
# The championship scoreboard.
#
# A circuit that publishes champions but not in-season scores cannot have a
# season progression board — there are no in-season scores to progress. This
# renders the same shell (year picker in the heading, .rk-grid, four cards)
# over the results that ARE published, and it is reached from data, not from a
# config flag: rankings.json declares kind:"championship". The day a real score
# feed lands, that file stops saying so and the DCI board takes over with no
# code change here.
#
# Every number on it is counted off the published title list
# (scripts/build_wgi_datasets.py derives that list from champions.json and
# asserts each row traces back to a real champion).
CHAMP_BOARD = """
  /* ---- year-range prose for the gaps in a championship record ---- */
  function champGapNote(years) {
    if (years.length < 2) return "";
    const have = new Set(years), miss = [];
    for (let y = Math.min(...years); y <= Math.max(...years); y++) if (!have.has(y)) miss.push(y);
    if (!miss.length) return "";
    const runs = [];
    miss.forEach(y => {
      const last = runs[runs.length - 1];
      if (last && y === last[1] + 1) last[1] = y; else runs.push([y, y]);
    });
    return "no championships " + runs.map(r => r[0] === r[1] ? String(r[0])
      : `${r[0]}–${String(r[1]).slice(-2)}`).join(", ");
  }

  async function champBoard(qs, stale, rk) {
    const winners = rk.winners || {};
    const classes = sortClasses(Object.keys(winners).filter(c => (winners[c] || []).length));
    const allYears = [...new Set(classes.flatMap(c => winners[c].map(w => +w[0])))].sort((a, b) => b - a);
    if (!classes.length || !allYears.length) {
      app.innerHTML = `<h1 class="page">Championships</h1>${noteHtml("board")}`
        + `<div class="card"><div class="empty">The championship record builds with the next data run.</div></div>`;
      return;
    }
    await ensureLogos();
    if (stale()) return;
    const latest = allYears.includes(+rk.season) ? +rk.season : allYears[0];
    const asked = +parseHashQuery(qs).y;
    const year = allYears.includes(asked) ? asked : latest;
    const gapNote = champGapNote(allYears);

    // which classes the chart draws — remembered per app, like the DCI board's
    // class picker. Never empty: clearing it falls back to every class.
    let saved = [];
    try {
      const s = JSON.parse(localStorage.getItem(NS("dt-champcls")) || "[]");
      if (Array.isArray(s)) saved = s.filter(c => classes.includes(c));
    } catch (e) {}
    const chartSet = new Set(saved.length ? saved : classes);

    app.innerHTML = h`
      <h1 class="page">${yearPickerHtml(year)} Championships</h1>
      ${noteHtml("board")}
      <div class="rk-grid">
        <div class="card rk-trend">
          <h2>Winning Score by Season <span class="sub keep" id="champChartSub"></span></h2>
          <div class="filters" style="margin:2px 0 8px"><div id="champClsSel"></div></div>
          <div class="chartwrap" id="champChart"></div>
        </div>
        <div class="card rk-stand">
          <h2 id="champStandTitle"></h2>
          <div id="champStandings"></div>
        </div>
        <div class="card rk-move" id="champMove"></div>
        <div class="card rk-battle" id="champDyn"></div>
      </div>`;
    wireYearPicker(allYears, year, y => { location.hash = y === latest ? "#/" : `#/?y=${y}`; });

    /* ---- the standings: this season's championships, one row per class ---- */
    const rows = classes.map(cls => {
      const w = (winners[cls] || []).find(x => +x[0] === year);
      if (!w) return null;
      const mine = (winners[cls] || []).filter(x => x[1] === w[1]).map(x => +x[0]).sort((a, b) => a - b);
      const prior = mine.filter(y => y < year);
      return { cls, corps: w[1], score: w[2], nth: mine.filter(y => y <= year).length,
        titles: mine.length, prev: prior.length ? prior[prior.length - 1] : null };
    }).filter(Boolean);
    document.getElementById("champStandTitle").innerHTML =
      `${esc(String(year))} World Championships <span class="sub keep">${rows.length} title${rows.length === 1 ? "" : "s"} awarded`
      + `${FAVS.list().length ? " · your favorites are starred" : ""}</span>`;
    document.getElementById("champStandings").innerHTML = rows.length ? `
      <div class="tscroll"><table class="t standings"><thead><tr><th>Class</th><th>Champion</th>
        <th class="num">Score</th><th class="num m-hide">Title #</th><th class="m-hide">Previously</th></tr></thead><tbody>
      ${rows.map(r => `<tr${FAVS.has(r.corps) ? ' class="favrow"' : ""}>
        <td><span class="pill">${esc(r.cls)}</span></td>
        <td><span class="corpscell">${corpsLogo(r.corps, 26)}<span class="corpscell-body">
          <span class="corpscell-name">${corpsLink(r.corps)}</span></span></span></td>
        <td class="num score">${score3(r.score)}</td>
        <td class="num m-hide" style="color:var(--muted)">${r.nth} of ${r.titles}</td>
        <td class="m-hide" style="color:var(--muted)">${r.prev ? "won " + r.prev : "first title"}</td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No championships on record for ${esc(String(year))}.</div>`;

    /* ---- the chart: every winning score this circuit has published ---- */
    function drawChart() {
      const el = document.getElementById("champChart");
      if (!el) return;
      const picked = sortClasses([...chartSet]);
      const pts = picked.reduce((n, c) => n + winners[c].filter(w => w[2] != null).length, 0);
      document.getElementById("champChartSub").textContent =
        `${pts} title score${pts === 1 ? "" : "s"} · ${allYears[allYears.length - 1]}–${allYears[0]}`
        + (gapNote ? ` · ${gapNote}` : "");
      lineChart(el, {
        linearX: true,
        series: picked.map(cls => ({
          name: cls, color: PALETTE[classes.indexOf(cls) % PALETTE.length],
          points: winners[cls].filter(w => w[2] != null).map(w => ({ x: +w[0], y: w[2] })),
        })),
        height: 340, xFmt: v => String(Math.round(v)), yFmt: v => v.toFixed(1),
      });
    }

    /* ---- biggest move: THIS season's winning score against the previous
           championship in the same class. Not every class is contested every
           year (and none was in 2020–21), so the card names both seasons
           rather than implying they are adjacent. ---- */
    function drawMove() {
      const moves = [];
      classes.filter(c => chartSet.has(c)).forEach(cls => {
        const ws = winners[cls].filter(w => w[2] != null).slice().sort((a, b) => a[0] - b[0]);
        const i = ws.findIndex(w => +w[0] === year);
        if (i < 1) return;
        const now = ws[i], before = ws[i - 1];
        moves.push({ cls, corps: now[1], y1: +before[0], y2: +now[0],
          s1: before[2], s2: now[2], d: +(now[2] - before[2]).toFixed(3) });
      });
      moves.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const j = moves[0];
      // the CLASS leads, not the champion: the previous score usually belongs
      // to a different ensemble, and putting this year's winner's name above
      // both numbers read as one ensemble's improvement
      document.getElementById("champMove").innerHTML = j ? h`
        <h2>Biggest Move <span class="sub">winning score vs the previous championship</span></h2>
        <div style="font-size:20px;font-weight:650">${esc(j.cls)}</div>
        <div style="color:var(--text-secondary)">${score3(j.s1)} <span class="kicker">${j.y1}</span> →
          <b>${score3(j.s2)}</b> <span class="kicker">${j.y2}</span> ${deltaHtml(j.d)}</div>
        <div style="margin-top:6px;font-size:13px">Taken by ${corpsLink(j.corps)}</div>
        ${moves.slice(1, 3).map(m => `<div style="font-size:13px;margin-top:6px">${esc(m.cls)} ${deltaHtml(m.d)} <span class="kicker">${esc(m.corps)}</span></div>`).join("")}`
        : `<h2>Biggest Move</h2><div class='empty'>No earlier championship in these classes to measure ${esc(String(year))} against.</div>`;
    }

    /* ---- dynasties: most titles in the charted classes ---- */
    function drawDyn() {
      const picked = new Set(chartSet);
      const by = new Map();
      classes.filter(c => picked.has(c)).forEach(cls => winners[cls].forEach(w => {
        const t = by.get(w[1]) || { corps: w[1], n: 0, last: 0 };
        t.n++; t.last = Math.max(t.last, +w[0]);
        by.set(w[1], t);
      }));
      const top = [...by.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 4)
        .filter(t => t.n > 1);
      document.getElementById("champDyn").innerHTML = top.length ? `
        <h2>Dynasties <span class="sub">most titles in these classes</span></h2>
        <table class="t">${top.map((t, i) => `<tr${FAVS.has(t.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td><td>${corpsLink(t.corps)}</td>
          <td class="num score">${t.n}</td><td class="num kicker">${t.last}</td></tr>`).join("")}</table>
        <div style="margin-top:8px;font-size:13px"><a href="#/records">The full record book →</a></div>`
        : "<h2>Dynasties</h2><div class='empty'>Nobody has won these classes twice yet.</div>";
    }

    multiSelect(document.getElementById("champClsSel"), {
      label: "Pick classes to chart…",
      summary: () => chartSet.size === classes.length ? "All classes" : null,
      bulk: true,
      options: classes.map(c => ({ value: c, label: c, hint: `${winners[c].length} titles` })),
      selected: chartSet,
      onChange: () => {
        if (!chartSet.size) classes.forEach(c => chartSet.add(c));
        try { localStorage.setItem(NS("dt-champcls"), JSON.stringify([...chartSet])); } catch (e) {}
        drawChart(); drawMove(); drawDyn();
      },
    });
    drawChart();
    drawMove();
    drawDyn();
  }
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
    # publishes no season scores at all — those apps chart what they do
    # publish, through champBoard() above.
    js = sub_once(
        js,
        """  async function viewRankings(qs, stale) {
    setNav("rankings");""",
        CHAMP_BOARD + """
  async function viewRankings(qs, stale) {
    setNav("rankings");
    if (FAM) {
      // the dataset says which board it can support: a circuit with no
      // in-season score feed ships kind:"championship" and charts its titles
      const rkc = await data("rankings.json").catch(() => null);
      if (stale()) return;
      if (rkc && rkc.kind === "championship") return champBoard(qs, stale, rkc);
    }""",
        "board shape hook")

    # ---- season lists: the schedule is not the whole record ----
    # meta.seasons is the SCHEDULE's season list (what seasons/<year>.json
    # exists for). On the DCI app that is also every season with results, so
    # the Champions and Ensembles views read it as "every season". A circuit
    # whose published results are its championship record has 47 seasons of
    # results and one season of schedule — reading meta alone showed exactly
    # one row on the Champions tab and defaulted Compare to a season with no
    # scores in it.
    js = sub_once(
        js,
        "    const years = meta.seasons.slice().sort((a, b) => b.year - a.year);",
        """    const years = meta.seasons.slice();
    if (FAM) {
      const have = new Set(years.map(s => s.year));
      Object.keys(champs || {}).forEach(y => { if (!have.has(+y)) years.push({ year: +y }); });
    }
    years.sort((a, b) => b.year - a.year);""",
        "champions season list")
    js = sub_once(
        js,
        "    const allYears = meta.seasons.map(s => s.year).sort((a, b) => b - a);",
        """    const allYears = [...new Set(meta.seasons.map(s => s.year).concat(
      FAM ? idx.flatMap(c => (c.series || []).map(sr => sr[0])) : []))].sort((a, b) => b - a);""",
        "compare season list")
    # a season with a published schedule but no results yet is not "in
    # progress" on an app whose scores arrive a year at a time
    js = sub_once(
        js,
        '"<span style=\'color:var(--muted)\'>season in progress…</span>"',
        '(FAM ? "<span style=\'color:var(--muted)\'>scheduled · no results published</span>"'
        ' : "<span style=\'color:var(--muted)\'>season in progress…</span>")',
        "champions in-progress label")
    # the COVID rows assert what happened to a season. That is DCI's history;
    # for another circuit all this dataset knows is that no title is on record.
    js = sub_once(
        js,
        'COVID-19 — ${r.y === 2020 ? "season canceled, no championships" : "no championships held"}',
        'COVID-19 — ${FAM ? "no championship on record"'
        ' : r.y === 2020 ? "season canceled, no championships" : "no championships held"}',
        "covid copy")
    # every year on the Champions table links to #/season/<y>, which redirects
    # to that season's Shows page. A championship-record app has no season
    # page for 1985 — but it does have a board for it.
    js = sub_once(
        js,
        "[/^#\\/season\\/(\\d{4})$/, m => { location.replace(`#/events?y=${m[1]}`); }],",
        "[/^#\\/season\\/(\\d{4})$/, m => { location.replace(FAM ? `#/?y=${m[1]}` : `#/events?y=${m[1]}`); }],",
        "season route")
    # a season row jumps to that season. On a championship record the seasons
    # with a title jump to the board for that year; a season that has only a
    # published schedule jumps to its Shows page instead of a board that
    # cannot show it.
    js = sub_once(
        js,
        '          return `<tr class="rowlink" data-y="${r.y}"><td><a href="#/season/${r.y}"><b>${r.y}</b></a>',
        '          const jump = !FAM || r.w ? `#/season/${r.y}` : r.events ? `#/events?y=${r.y}` : "";\n'
        '          return `<tr${jump ? ` class="rowlink" data-h="${jump}"` : ""}>'
        '<td>${jump ? `<a href="${jump}"><b>${r.y}</b></a>` : `<b>${r.y}</b>`}',
        "champions row link")
    js = sub_once(
        js,
        """      document.querySelectorAll("#champRows tr[data-y]").forEach(tr => {
        tr.onclick = e => {
          if (e.target.closest("a")) return;
          location.hash = `#/season/${tr.dataset.y}`;
        };
      });""",
        """      document.querySelectorAll("#champRows tr[data-h]").forEach(tr => {
        tr.onclick = e => {
          if (e.target.closest("a")) return;
          location.hash = tr.dataset.h;
        };
      });""",
        "champions row handler")
    js = sub_once(
        js,
        "Tap a year for that season — every show, every score, full recaps.",
        "${FAM ? \"Tap a year for that season's championships.\""
        " : \"Tap a year for that season — every show, every score, full recaps.\"}",
        "champions footnote")

    # ---- profiles built from a record with no dates ----
    # Every performance on a championship-record app is a title, and the
    # published record carries no dates. renderCorpsDetail assumes dates
    # throughout: the default season chart plots score-by-date and drew an
    # empty box, and the hero's four season tiles ("Points gained", "Shows")
    # describe a season of touring that this ensemble never published.
    js = sub_once(
        js,
        "    const bestPerf = scored.length ? scored.reduce((m, p) => p.s > m.s ? p : m, scored[0]) : null;",
        "    // does this app publish performance DATES? Without them there is no\n"
        "    // within-season progression to chart or summarise — the career view is\n"
        "    // the only honest one.\n"
        "    const DATED = perfs.some(p => p.d);\n"
        "    const bestPerf = scored.length ? scored.reduce((m, p) => p.s > m.s ? p : m, scored[0]) : null;",
        "dated flag")
    js = sub_once(
        js,
        "      const agg = seasonAgg(yr);",
        "      const agg = DATED ? seasonAgg(yr) : null;",
        "hero career tiles")
    # …and the career tiles themselves: on a championship record "Titles",
    # "Performances" and "Seasons" are the same number three times. The span
    # of the career says something the other two don't.
    js = sub_once(
        js,
        """        : cell(bestPerf ? score3(bestPerf.s) : "—", "Best score")
          + cell(titles.length, "Titles")
          + cell(perfs.length, "Performances")
          + cell(years.length, "Seasons");""",
        """        : cell(bestPerf ? score3(bestPerf.s) : "—", "Best score")
          + cell(titles.length, "Titles")
          + (FAM && titles.length === perfs.length
            ? cell(years[0] ?? "—", "First title") + cell(years[years.length - 1] ?? "—", "Latest title")
            : cell(perfs.length, "Performances") + cell(years.length, "Seasons"));""",
        "career tile labels")
    # the career chart: on the DCI app a gap in the years IS missing data, so
    # the line breaks. On a championship record a gap is a season the ensemble
    # did not win — real, and the line through their title scores is the story.
    js = sub_once(
        js,
        '      title.innerHTML = `Top Score by Year${range ? ` — ${range}` : ""} <span class="sub">gaps = seasons not yet in the database · ',
        '      title.innerHTML = `${FAM && !DATED ? "Title Score by Season" : "Top Score by Year"}'
        '${range ? ` — ${range}` : ""} <span class="sub">'
        '${FAM && !DATED ? "one point per title — a gap is a season they did not win" : "gaps = seasons not yet in the database"} · ',
        "career chart title")
    js = sub_once(
        js,
        "        if (cur.length && p.x - cur[cur.length - 1].x > 1) { segs.push(cur); cur = []; }",
        "        if (DATED && cur.length && p.x - cur[cur.length - 1].x > 1) { segs.push(cur); cur = []; }",
        "career chart segments")
    js = sub_once(
        js,
        '<h2>Championships <span class="sub">each year\'s last score & championship finish</span></h2>',
        '<h2>Championships <span class="sub">${FAM && !DATED ? "every title, and the class it was won in"'
        ' : "each year\'s last score &amp; championship finish"}</span></h2>',
        "champs card sub")
    js = sub_once(
        js,
        "      if (sel.length === 1) {\n        const yv = sel[0];",
        "      if (sel.length === 1 && DATED) {\n        const yv = sel[0];",
        "chart needs dates")
    js = sub_once(
        js,
        "      if (sel.length > 1 && sel.length <= 8) {",
        "      if (sel.length > 1 && sel.length <= 8 && DATED) {",
        "overlay needs dates")
    # the whole career, not the latest season, is the profile's default view
    # when a season holds a single dateless row
    js = sub_once(
        js,
        '    const yearSet = new Set(years.length ? [String(years[years.length - 1])] : []);',
        '    const yearSet = new Set(years.length && DATED ? [String(years[years.length - 1])] : []);',
        "profile default years")
    # "vs prev" is change from the previous show THAT SEASON; a season with a
    # single show has no previous show, and printing ±0.0 implied one
    # …and without dates there is no "previous show that season" at all, so the
    # column read "—" on every row and pushed the log into a sideways scroll
    js = sub_once(
        js,
        '<th class="num" title="Change from this corps\' previous show that season">vs prev</th>',
        '${!DATED ? "" : `<th class="num" title="Change from this corps\' previous show that season">vs prev</th>`}',
        "vs-prev header")
    js = sub_once(
        js,
        """          <td class="num">${p.p ?? "—"}</td><td class="num score">${score3(p.s)}</td>
          <td class="num">${p.s == null ? '<span class="delta flat">—</span>' : deltaHtml(deltaByPerf.get(p))}</td></tr>`""",
        """          <td class="num">${p.p ?? "—"}</td><td class="num score">${score3(p.s)}</td>
          ${!DATED ? "" : `<td class="num">${p.s == null ? '<span class="delta flat">—</span>' : deltaHtml(deltaByPerf.get(p))}</td>`}</tr>`""",
        "vs-prev cell")
    js = sub_once(
        js,
        '`<tr><td colspan="6" class="empty">No performances on record',
        '`<tr><td colspan="${DATED ? 6 : 5}" class="empty">No performances on record',
        "perf empty colspan")
    js = sub_once(
        js,
        "      ordered.forEach((p, i) => deltaByPerf.set(p, i === 0 ? 0 : +(p.s - ordered[i - 1].s).toFixed(3)));",
        "      ordered.forEach((p, i) => deltaByPerf.set(p,\n"
        "        i === 0 ? (ordered.length > 1 ? 0 : null) : +(p.s - ordered[i - 1].s).toFixed(3)));",
        "single-show delta")
    # championship finish: "1st ·  · Independent World" — the round is blank
    # when the record names no round, and the separator was printed anyway
    js = sub_once(
        js,
        '<b>${ordinal(r.fin.p)}</b> <span class="kicker">· ${roundOf(r.fin.ev || "")}${r.fin.cls ? ` · ${esc(r.fin.cls)}` : ""}</span>',
        '<b>${ordinal(r.fin.p)}</b> <span class="kicker">${[roundOf(r.fin.ev || ""), r.fin.cls]'
        '.filter(Boolean).map(x => " · " + esc(x)).join("")}</span>',
        "champ finish separator")

    # ---- the record book of a championship-only record ----
    # Two of the six Records cards read the finals sheet: "Finals Margins"
    # needs the runner-up's score and "Most Finals Made" counts everyone who
    # made finals. A circuit that publishes only the champion has neither, and
    # both cards rendered "widen the era filter" as if the reader had filtered
    # them away. The same title list answers two questions it CAN answer.
    js = sub_once(
        js,
        '      const finalsSpan = champYears.length ? `${champYears[0]}–${champYears[champYears.length - 1]}` : "";',
        """      const finalsSpan = champYears.length ? `${champYears[0]}–${champYears[champYears.length - 1]}` : "";

      // longest span from a first title to a latest one, and the longest wait
      // between two consecutive titles — both counted straight off the years
      // in `titleBy`, which the era and corps filters have already narrowed
      const spans = [...titleBy.entries()].map(([n, t]) => ({ corps: n, n: t.n,
        first: t.years[0], last: t.years[t.years.length - 1],
        span: t.years[t.years.length - 1] - t.years[0] }))
        .filter(s => s.n > 1).sort((a, b) => b.span - a.span || b.n - a.n);
      const spansHtml = spans.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>${TERM_TH}</th><th class="num">Span</th><th class="num m-hide">Titles</th><th>First – Last</th></tr></thead><tbody id="recSpans">
        ${spans.map(s => `<tr><td>${corpsLink(s.corps)}</td><td class="num score">${s.span} yr${s.span === 1 ? "" : "s"}</td>
          <td class="num m-hide">${s.n}</td><td class="kicker">${s.first}–${s.last}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;
      const gaps = [];
      titleBy.forEach((t, n) => {
        for (let i = 1; i < t.years.length; i++)
          gaps.push({ corps: n, from: t.years[i - 1], to: t.years[i], gap: t.years[i] - t.years[i - 1] });
      });
      gaps.sort((a, b) => b.gap - a.gap || b.to - a.to);
      const gapsHtml = gaps.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>${TERM_TH}</th><th class="num">Wait</th><th>Between</th></tr></thead><tbody id="recGaps">
        ${gaps.map(g => `<tr><td>${corpsLink(g.corps)}</td><td class="num score">${g.gap} yr${g.gap === 1 ? "" : "s"}</td>
          <td class="kicker">${g.from} → ${g.to}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;""",
        "records span/gap tables")
    js = sub_once(
        js,
        """        <div class="card" style="margin-top:14px">
          <h2>Finals Margins <span class="sub">champion vs runner-up on the last night</span></h2>
          <div class="filters" style="margin:2px 0 8px">
            <button class="tab${marginMode === "closest" ? " on" : ""}" data-mm="closest">Closest ever</button>
            <button class="tab${marginMode === "biggest" ? " on" : ""}" data-mm="biggest">Biggest blowouts</button>
          </div>
          ${marginsHtml}
        </div>
        <div class="grid cols-2" style="margin-top:14px">
          ${card("Biggest One-Season Leaps", "season best vs the year before", leapsHtml)}
          ${card("Most Finals Made", "championship-finals appearances", appsHtml)}
        </div>`;""",
        """        ${FAM ? `<div class="grid cols-2" style="margin-top:14px">
          ${card("Longest Title Span", "first title to latest", spansHtml)}
          ${card("Longest Wait Between Titles", "consecutive titles, years apart", gapsHtml)}
        </div>
        <div style="margin-top:14px">${card("Biggest One-Season Leaps", "winning score vs the year before", leapsHtml)}</div>`
        : `<div class="card" style="margin-top:14px">
          <h2>Finals Margins <span class="sub">champion vs runner-up on the last night</span></h2>
          <div class="filters" style="margin:2px 0 8px">
            <button class="tab${marginMode === "closest" ? " on" : ""}" data-mm="closest">Closest ever</button>
            <button class="tab${marginMode === "biggest" ? " on" : ""}" data-mm="biggest">Biggest blowouts</button>
          </div>
          ${marginsHtml}
        </div>
        <div class="grid cols-2" style="margin-top:14px">
          ${card("Biggest One-Season Leaps", "season best vs the year before", leapsHtml)}
          ${card("Most Finals Made", "championship-finals appearances", appsHtml)}
        </div>`}`;""",
        "records card swap")
    js = sub_once(
        js,
        '      ["recTop", "recTitles", "recStreaks", "recMargins", "recLeaps", "recApps"].forEach(id => {',
        '      ["recTop", "recTitles", "recStreaks", "recMargins", "recLeaps", "recApps",\n'
        '        "recSpans", "recGaps"].forEach(id => {',
        "records collapse ids")
    js = sub_once(
        js,
        '${card("Highest Scores Ever", "the best single performances on record", topHtml)}',
        '${card(FAM ? "Highest Winning Scores" : "Highest Scores Ever",\n'
        '          FAM ? "the best championship-winning scores on record" : "the best single performances on record", topHtml)}',
        "records top card label")

    # ---- what each screen does NOT have, said once ----
    js = sub_once(
        js,
        '      <h1 class="page">Records <span class="kicker">· the all-time book</span></h1>',
        '      <h1 class="page">Records <span class="kicker">· the all-time book</span></h1>\n'
        '      ${noteHtml("records")}',
        "records note")
    # the Database's Year column is m-hide (the Date cell carries the year on a
    # phone). With no dates, that left every phone row with no season at all.
    js = sub_once(
        js,
        '      if (i === cfg.dateIdx) return `<td style="color:var(--muted);white-space:nowrap">${fmtDate2(r[i])}</td>`;',
        '      if (i === cfg.dateIdx) return `<td style="color:var(--muted);white-space:nowrap">${fmtDate2(r[i], FAM ? r[0] : null)}</td>`;',
        "database dateless year")
    js = sub_once(
        js,
        '''    app.innerHTML = `${dataSubNav("database")}<h1 class="page">Database <span id="dbcount" class="kicker"></span></h1>''',
        '''    app.innerHTML = `${dataSubNav("database")}<h1 class="page">Database <span id="dbcount" class="kicker"></span></h1>
      ${noteHtml("database")}''',
        "database note")
    js = sub_once(
        js,
        '''      <h1 class="page">Shows ${yearPickerHtml(year)} <span class="kicker" id="evCount"></span></h1>''',
        '''      <h1 class="page">Shows ${yearPickerHtml(year)} <span class="kicker" id="evCount"></span></h1>
      ${noteHtml("events")}''',
        "events note")
    js = sub_once(
        js,
        '''    app.innerHTML = `
      <h1 class="page" id="corpsPageTitle">Corps</h1>
      <div class="filters">
        <div id="cpCls"></div>''',
        '''    app.innerHTML = `
      <h1 class="page" id="corpsPageTitle">Corps</h1>
      ${noteHtml("corps")}
      <div class="filters">
        <div id="cpCls"></div>''',
        "ensembles note")
    js = sub_once(
        js,
        '''      ${dataSubNav("compare")}
      <h1 class="page">Compare <span class="kicker">· any corps, any seasons</span></h1>''',
        '''      ${dataSubNav("compare")}
      <h1 class="page">Compare <span class="kicker">· any corps, any seasons</span></h1>
      ${noteHtml("compare")}''',
        "compare note")
    js = sub_once(
        js,
        '''      <div class="card corps-perf" style="margin-top:14px"><h2 id="perfTitle">Performance Log</h2>
        <div id="perfTable"></div></div>''',
        '''      <div class="card corps-perf" style="margin-top:14px"><h2 id="perfTitle">Performance Log</h2>
        ${NOTE("profile") ? `<p class="kicker" style="margin:0 0 8px">${esc(NOTE("profile"))}</p>` : ""}
        <div id="perfTable"></div></div>''',
        "profile note")

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

    # Settings > Team Colors. Two hardcoded DCI assumptions leaked onto every
    # family app: the picker seeded its list from CORPS_THEME (a literal list of
    # drum corps), so a WGI Color Guard user was offered Bluecoats and Boston
    # Crusaders — ensembles that have never competed in WGI — and it harvested
    # standings from the literal DCI class names, which are not WGI's, so none
    # of the app's OWN ensembles appeared. Read the app's classes, and drop the
    # DCI seed and the DCI featured row on a family app.
    js = sub_once(
        js,
        '      ["World Class", "Open Class", "All-Age"].forEach(c => (st[c] && st[c].rows || []).forEach(r => r.corps && all.push(r.corps)));',
        '      (FAM ? CLASS_ORDER : ["World Class", "Open Class", "All-Age"])\n'
        '        .forEach(c => (st[c] && st[c].rows || []).forEach(r => r.corps && all.push(r.corps)));',
        "theme picker classes")
    js = sub_once(
        js,
        "    Object.keys(CORPS_THEME).forEach(n => all.push(n));",
        "    if (!FAM) Object.keys(CORPS_THEME).forEach(n => all.push(n));\n"
        "    // a family app has no CORPS_THEME to seed from, so its own roster is\n"
        "    // the list — the whole index, not just this season's champions\n"
        "    if (FAM) { try { (await data(\"corps_index.json\") || []).forEach(r => r.name && all.push(r.name)); } catch (e) {} }",
        "theme picker DCI seed")
    js = sub_once(
        js,
        "    const featured = THEME_FEATURED.filter(n => all.includes(n) || CORPS_THEME[n]);",
        "    const featured = FAM ? [] : THEME_FEATURED.filter(n => all.includes(n) || CORPS_THEME[n]);",
        "theme picker featured row")

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
