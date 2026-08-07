#!/usr/bin/env python3
"""Derive the Cadence family engine (docs/family/app.js) from the DCI app
(docs/app.js), plus a family copy of wrapped.js for share cards.

The DCI app is never modified. Family instances (WGI activities, BOA,
A Cappella, Show Choir) load docs/family/app.js with a `window.APP_CFG`
config that supplies class lists, terminology and a storage namespace, so
every instance behaves exactly like the DCI app with its own data.

Each transform asserts its anchor exists — if docs/app.js drifts, this
script fails loudly (and so does the deploy) instead of silently shipping a
broken family engine.

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
   { appName, ns, classOrder, combinable, terms:{singular,plural,a},
     eventsTitle } */
"""

FAM_BOOTSTRAP = """  // --- Cadence family config (absent on the DCI app, set by instances) ---
  const FAM = window.APP_CFG || null;
  const NS = k => (FAM ? FAM.ns : "") + k;
  const TERM = FAM ? FAM.terms : { singular: "corps", plural: "corps", a: "a corps" };
"""

SETTINGS_INJECT = """
    if (FAM) (async () => {
      app.querySelectorAll(".setcard").forEach(c => {
        const t = ((c.querySelector("h2") || {}).textContent) || "";
        if (/Add to Home Screen|Notifications|Prediction/i.test(t)) c.remove();
      });
      let clsList = [];
      try { clsList = sortClasses(Object.keys((await data("rankings.json")).standings || {})); } catch (e) {}
      if (!clsList.length) return;
      const pref = (k, dflt) => { try { const v = localStorage.getItem(NS(k)); return v == null ? dflt : v; } catch (e) { return dflt; } };
      const setPref = (k, v) => { try { localStorage.setItem(NS(k), v); } catch (e) {} };
      let on = null;
      try { on = JSON.parse(pref("cad-notify-classes", "null")); } catch (e) {}
      const onSet = new Set(Array.isArray(on) ? on.filter(c => clsList.includes(c)) : clsList);
      const alertsOn = pref("cad-notify-on", "on") === "on";
      const favsOnly = pref("cad-notify-scope", "all") === "favs";
      const card = document.createElement("div");
      card.className = "card setcard";
      card.innerHTML = `<h2>Notifications</h2>
        <p class="setnote">Set up exactly what you want a ping for — alerts go live automatically the moment ${esc(FAM.appName)} has a live data feed.</p>
        <div class="setrow">
          <div><b>Score alerts</b><div class="setsub">A ping when new scores land</div></div>
          <button class="toggle${alertsOn ? " on" : ""}" id="famNotifyOn" aria-pressed="${alertsOn}" aria-label="Score alerts"></button>
        </div>
        <div class="setrow">
          <div><b>Only my favorites</b><div class="setsub">Alert just for your ★ ${esc(TERM.plural)}</div></div>
          <button class="toggle${favsOnly ? " on" : ""}" id="famNotifyFavs" aria-pressed="${favsOnly}" aria-label="Favorites only"></button>
        </div>
        <div class="setrow setrow-classes">
          <div><b>Which classes</b><div class="setsub">Only alert me for the classes I follow</div></div>
        </div>
        <div class="classchips">${clsList.map(c => `<button class="classchip${onSet.has(c) ? " on" : ""}" data-ncls="${esc(c)}" aria-pressed="${onSet.has(c)}">${esc(c)}</button>`).join("")}</div>`;
      const foot = app.querySelector(".setfoot");
      if (foot) app.insertBefore(card, foot); else app.appendChild(card);
      const wireToggle = (id, apply) => card.querySelector(id).addEventListener("click", e => {
        const now = !e.currentTarget.classList.contains("on");
        e.currentTarget.classList.toggle("on", now);
        e.currentTarget.setAttribute("aria-pressed", String(now));
        apply(now);
      });
      wireToggle("#famNotifyOn", now => setPref("cad-notify-on", now ? "on" : "off"));
      wireToggle("#famNotifyFavs", now => setPref("cad-notify-scope", now ? "favs" : "all"));
      card.querySelectorAll("[data-ncls]").forEach(b => b.addEventListener("click", () => {
        const c = b.dataset.ncls;
        if (onSet.has(c)) onSet.delete(c); else onSet.add(c);
        b.classList.toggle("on", onSet.has(c));
        setPref("cad-notify-classes", JSON.stringify([...onSet]));
      }));
    })();
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

    # stats hub: no captions tab for family; #/data lands on Compare
    js = sub_once(
        js,
        'const DATA_SUBS = [["captions", "Captions"], ["compare", "Compare"], ["champions", "Champions"], ["records", "Records"], ["database", "Database"]];',
        'const DATA_SUBS = (FAM ? [] : [["captions", "Captions"]]).concat([["compare", "Compare"], ["champions", "Champions"], ["records", "Records"], ["database", "Database"]]);',
        "data subs")
    js = sub_once(js, '[/^#\\/data$/, () => { location.replace("#/captions"); }],',
                  '[/^#\\/data$/, () => { location.replace(FAM ? "#/compare" : "#/captions"); }],',
                  "data route")

    js = sub_once(
        js,
        "[/^#\\/captions(?:\\?(.*))?$/, (m, st) => viewCaptions(m[1], st)],",
        "[/^#\\/captions(?:\\?(.*))?$/, (m, st) => { if (FAM) { location.replace(\"#/compare\"); return; } return viewCaptions(m[1], st); }],",
        "captions family redirect")

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
        (">Pick a corps</h2>", ">Pick ${TERM.a}</h2>", 1),
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
        ('<h1 class="page">Shows <span', '<h1 class="page">${FAM ? FAM.eventsTitle : "Shows"} <span', 1),
        ('· any corps, any seasons', '· any ${TERM.singular}, any seasons', 1),
        ('· the record book, 1972–today', '· the record book${FAM ? "" : ", 1972–today"}', 1),
    ]
    for old, new, count in pairs:
        js = sub_once(js, old, new, f"term: {old[:40]}", count)

    # table column headers and the ensembles page title
    js, n = re.subn(r'>Corps<', '>${TERM_TH}<', js)
    assert n == 13, f"'Corps' table headers: {n}"
    js = sub_once(js, "  const TERM = FAM ? FAM.terms",
                  "  const TERM = FAM ? FAM.terms", "term anchor present")
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
        '  const TERM_TH = FAM ? FAM.terms.singular.charAt(0).toUpperCase() + FAM.terms.singular.slice(1) : "Corps";',
        "TERM_TH")

    # custom tabs: a nav anchor carrying data-href highlights on exact hash
    # prefix (used by each circuit's championship tab)
    js = sub_once(
        js,
        """  function setNav(route) {
    document.querySelectorAll("#nav a").forEach(a =>
      a.classList.toggle("active", a.dataset.route === route));""",
        """  function setNav(route) {
    const hashv = location.hash || "#/";
    const links = [...document.querySelectorAll("#nav a")];
    const exact = links.find(a => a.dataset.href && hashv.indexOf(a.dataset.href) === 0);
    links.forEach(a =>
      a.classList.toggle("active", exact ? a === exact : a.dataset.route === route));""",
        "setNav data-href")

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

    # fifth tab: per-tab memory must know the champions tab, and #/champions
    # is its own section on family apps (not part of Stats), else the nav
    # rewrite sets its href to the literal string "undefined" → 404
    js = sub_once(
        js,
        'const NAV_DEFAULT = { rankings: "#/", events: "#/events", corps: "#/corps", data: "#/captions" };',
        'const NAV_DEFAULT = { rankings: "#/", events: "#/events", corps: "#/corps", data: FAM ? "#/compare" : "#/captions", champions: "#/champions" };',
        "nav defaults")
    js = sub_once(
        js,
        'if (/^#\\/(data|compare|captions|champions|seasons|records|database)/.test(hash)) return "data";',
        'if (FAM && /^#\\/(champions|seasons)/.test(hash)) return "champions";\n'
        '    if (/^#\\/(data|compare|captions|champions|seasons|records|database)/.test(hash)) return "data";',
        "sectionOf champions")

    # champions view: friendly state instead of "undefined" when the record
    # book is empty (e.g. an adapter's first season is still ingesting)
    js = sub_once(
        js,
        "    // one table: every season, its champion, click through to the year\n    const clsSet = new Set();",
        "    // one table: every season, its champion, click through to the year\n    const clsSet = new Set();\n"
        "    if (FAM) { try { const _ch = await data(\"champions.json\"); if (!Object.keys(_ch || {}).length) { const t = document.getElementById(\"champT\"); if (t) t.innerHTML = \"<tr><td class='empty'>The record book fills in with this app's first full season of data.</td></tr>\"; const cs = document.getElementById(\"champSub\"); if (cs) cs.textContent = \"\"; return; } } catch (e) {} }",
        "champions empty guard")

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

    # per-sector scoreboard framing note (BOA/ACA/SC honesty line under the h1)
    js = sub_once(
        js,
        '<h1 class="page">${esc(String(rk.season))} Scoreboard</h1>',
        '<h1 class="page">${esc(String(rk.season))} Scoreboard</h1>'
        '${FAM && FAM.scoreNote ? `<p class="kicker" style="margin:-6px 2px 12px">${esc(FAM.scoreNote)}</p>` : ""}',
        "score note")

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

    # settings: strip DCI-only cards, add per-class notification prefs
    js = sub_once(
        js,
        '<p class="setfoot">Preferences are saved on this device. Created by Lucas Besel.</p>`;\n    if (stale()) return;',
        '<p class="setfoot">Preferences are saved on this device. Created by Lucas Besel.</p>`;\n    if (stale()) return;\n' + SETTINGS_INJECT,
        "settings inject")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "app.js").write_text(HEADER + js)

    # wrapped.js: share cards print the family app's own URL, not DCI-Tracker's
    wj = (ROOT / "docs" / "wrapped.js").read_text()
    wj = sub_once(wj, 'var SITE_URL = "https://lukebesel.github.io/DCI-Tracker";',
                  'var SITE_URL = (window.APP_CFG && window.APP_CFG.siteUrl) || "https://lukebesel.github.io/Cadence-Labs";',
                  "wrapped url")
    wj = sub_once(wj, 'var SITE_LABEL = "lukebesel.github.io/DCI-Tracker";',
                  'var SITE_LABEL = (window.APP_CFG && window.APP_CFG.siteLabel) || "lukebesel.github.io/Cadence-Labs";',
                  "wrapped label")
    (OUT_DIR / "wrapped.js").write_text(wj)

    print(f"wrote {OUT_DIR/'app.js'} ({len(js)//1024}KB) and {OUT_DIR/'wrapped.js'}")


if __name__ == "__main__":
    main()
