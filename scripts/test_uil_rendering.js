#!/usr/bin/env node
/* Fixture tests for the ratings/placements circuits (UIL) in the derived
 * family engine.
 *
 *   node scripts/test_uil_rendering.js
 *
 * Everything under test is pulled out of the BUILT engine
 * (docs/family/app.js) — never reimplemented here. Where a finding is about
 * what a page RENDERS, the test runs the shipped view function itself
 * (viewCorpsHub / renderCorpsDetail / viewDatabase) against a minimal fake
 * DOM and the real shipped data files, then reads the HTML it produced. That
 * is deliberate: an earlier version of this file asserted on source
 * substrings pulled out with snippet(), and six behaviour changes could be
 * reverted at the call sites with the whole suite still green.
 *
 * Covers:
 *   #21  State placements render as places ("3rd"), never as Division
 *        ratings ("III")
 *   #24  Compare never charts Division ratings and State placements on one
 *        axis, and the Gain column reads as an improvement
 *   #25  normKind fills the score channel the row actually has — corps
 *        profiles key performances on `s`, not `score`
 *   #26  the Alerts card covers every app in docs/registry.js
 *   #27  the Database Scores set shows the Rating column the rows carry
 *        instead of an always-null Score column, and sorts best-first
 *   #28  "Biggest One-Season Leaps" ranks a DROP in rating as the leap
 *   #29  no season-card Share button where there are no point scores
 *   #30  no Caption Scores dataset — and no Caption Scores tile — where the
 *        app ships no captions
 *   R1   no chart invents a Division "0" or repeats a numeral: an ordinal
 *        scale is drawn on its own full domain, not on ticks chosen off a
 *        padded numeric range
 *   R3   no dead hero tile ("+0 improved", "Shows 1", a Class rank that can
 *        never be computed) on a ratings profile
 *   R6   a Compare row promises the scale it actually expands into
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "docs", "family", "app.js"), "utf8");
const chartsSrc = fs.readFileSync(path.join(ROOT, "docs", "charts.js"), "utf8");
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
// a section that throws is a FAILURE, not a crash with a stack trace — a
// missing anchor must be reported next to everything else that ran
const SECTIONS = [];
const test = (name, fn) => SECTIONS.push([name, fn]);

/* ── pulling real code out of the built engine ─────────────────────────────
   A scanner that knows about strings, template literals (including nested
   ${…}) and comments, so a definition can be lifted verbatim however much
   punctuation it contains. */
function endOf(text, from, stopAtSemi) {
  const OPEN = { "{": "}", "(": ")", "[": "]" };
  // a "/" starts a regex literal only where a value may begin — after a
  // closing paren/bracket or an identifier it is division
  const RE_OK = new Set("(,=:!&|?{};+-*%^~<>[\n".split(""));
  const RE_WORDS = /\b(return|typeof|case|in|of|new|delete|void|instanceof|yield|await|do|else)$/;
  const stack = [], modes = [];
  let mode = "code", lastSig = "", reClass = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (mode === "lc") { if (c === "\n") mode = modes.pop(); continue; }
    if (mode === "bc") { if (c === "*" && n === "/") { i++; mode = modes.pop(); } continue; }
    if (mode === "sq" || mode === "dq") {
      if (c === "\\") { i++; continue; }
      if (c === (mode === "sq" ? "'" : '"')) mode = modes.pop();
      continue;
    }
    if (mode === "re") {
      if (c === "\\") { i++; continue; }
      if (c === "[") reClass = true;
      else if (c === "]") reClass = false;
      else if (c === "/" && !reClass) mode = modes.pop();
      continue;
    }
    if (mode === "tpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { mode = modes.pop(); continue; }
      if (c === "$" && n === "{") { modes.push(mode); stack.push("$"); mode = "code"; i++; }
      continue;
    }
    if (c === "/" && n === "/") { modes.push(mode); mode = "lc"; i++; continue; }
    if (c === "/" && n === "*") { modes.push(mode); mode = "bc"; i++; continue; }
    if (c === "/" && (RE_OK.has(lastSig) || !lastSig || RE_WORDS.test(text.slice(Math.max(0, i - 12), i).trimEnd()))) {
      modes.push(mode); mode = "re"; reClass = false; continue;
    }
    if (c === "'") { modes.push(mode); mode = "sq"; lastSig = c; continue; }
    if (c === '"') { modes.push(mode); mode = "dq"; lastSig = c; continue; }
    if (c === "`") { modes.push(mode); mode = "tpl"; lastSig = c; continue; }
    if (/\S/.test(c)) lastSig = c;
    if (OPEN[c]) { stack.push(OPEN[c]); continue; }
    if (c === "}" || c === ")" || c === "]") {
      const top = stack[stack.length - 1];
      if (top === "$" && c === "}") { stack.pop(); mode = modes.pop(); continue; }
      if (top === c) { stack.pop(); if (!stack.length && !stopAtSemi) return i + 1; continue; }
    }
    if (stopAtSemi && c === ";" && !stack.length) return i;
  }
  throw new Error("unbalanced source from offset " + from);
}
// `const NAME = …;` — returns [start, end) of the whole statement
function spanOfConst(name) {
  const tag = `\n  const ${name} = `;
  const at = src.indexOf(tag);
  if (at < 0) throw new Error(`no const ${name} in the built engine`);
  const start = at + 1;
  return [start, endOf(src, start + tag.length - 1, true) + 1];
}
// `function NAME(…) { … }` — returns [start, end)
function spanOfFn(name) {
  const tag = `\n  ${/^[a-z]/.test(name) ? "" : ""}function ${name}(`;
  let at = src.indexOf(tag);
  if (at < 0) at = src.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`no function ${name} in the built engine`);
  const start = at + 1;
  return [start, endOf(src, src.indexOf("{", start))];
}
const sliceOf = sp => src.slice(sp[0], sp[1]);
// the initializer of a `const`, for the few places a value (not a call site)
// is the thing under test
function extract(name) { return sliceOf(spanOfConst(name)).replace(/^\s*const\s+\w+\s*=\s*/, "").replace(/;\s*$/, ""); }
// a literal line of shipped source. Missing text is a FAIL, never a throw.
function snippet(text) {
  ok(src.indexOf(text) >= 0, `the built engine still contains: ${text.slice(0, 60)}…`);
  return src.indexOf(text) >= 0 ? text : "/* MISSING */";
}

/* ── a fake DOM, just big enough for the shipped views ─────────────────── */
const escHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fakeDom() {
  const byId = new Map();
  const ths = { html: null, list: [] };
  function mkEl(id) {
    let html = "", text = "";
    const el = {
      id, hidden: false, value: "", disabled: false,
      dataset: {}, style: { setProperty() {} }, onclick: null,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      appendChild() {}, removeChild() {}, after() {}, remove() {},
      addEventListener() {}, scrollIntoView() {}, focus() {}, click() {},
      closest: () => null, setAttribute() {}, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 860, height: 300, left: 0, top: 0 }),
    };
    Object.defineProperty(el, "innerHTML", { get: () => html, set: v => { html = String(v); } });
    // browsers escape &, < and > when a text node is serialized — charts.js's
    // esc() is built on exactly that, so the fake has to behave the same way
    Object.defineProperty(el, "textContent", {
      get: () => text, set: v => { text = String(v == null ? "" : v); html = escHtml(v); },
    });
    return el;
  }
  const document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, mkEl(id)); return byId.get(id); },
    createElement: () => mkEl("created"),
    createTextNode: () => mkEl("text"),
    querySelector: () => null,
    // the one selector the shipped code actually sweeps: the Database header
    // row. Serve real <th> stubs off the rendered HTML so the shipped sort
    // handler is the thing under test.
    querySelectorAll(sel) {
      if (sel === "#dbtable th") {
        const html = document.getElementById("dbtable").innerHTML;
        // one node per rendered header, reused until the table is re-rendered,
        // so the handler render() binds is the handler the test clicks
        if (ths.html !== html) {
          ths.html = html;
          ths.list = [...html.matchAll(/<th[^>]*data-c="(\d+)"/g)].map(m => {
            const th = mkEl("th");
            th.dataset.c = m[1];
            return th;
          });
        }
        return ths.list;
      }
      return [];
    },
    documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {} } },
    body: mkEl("body"),
  };
  return { document, el: id => document.getElementById(id) };
}

/* ── the engine sandbox ────────────────────────────────────────────────────
   Real definitions lifted from the built file (in source order, so the
   engine's own declaration order is preserved), plus stubs for the browser
   and for the leaf helpers a headless run cannot have. `fetch` is backed by
   the shipped data files, so data() — including its normKind pass — is the
   real loader. */
const ENGINE_DEFS = [
  ["const", "cache"], ["fn", "data"],
  ["const", "score3"], ["const", "h"],
  ["fn", "resultsKind"], ["fn", "hasCaptions"],
  ["const", "lowerIsBetter"], ["const", "bestOf"], ["const", "isPlaced"],
  ["fn", "scaleTicks"], ["fn", "ratingChart"], ["const", "scoreChart"],
  ["const", "MONTHS"], ["fn", "fmtDate"], ["fn", "fmtDateY"], ["fn", "fmtDate2"],
  ["fn", "dayOfSeason"], ["fn", "dayLabel"], ["fn", "deltaHtml"], ["const", "slugOf"],
  ["const", "CLASS_ORDER"], ["const", "TYPE_FAMILIES"],
  ["const", "DATA_SUBS"], ["const", "dataSubNav"], ["const", "sortClasses"],
  ["const", "YEAR_DASHES"], ["fn", "parseHashQuery"], ["const", "corpsClass"],
  ["fn", "viewCorpsHub"], ["fn", "renderCorpsDetail"],
  ["const", "DB"], ["fn", "loadScores"], ["fn", "loadCaptionRows"],
  ["const", "DB_SETS"], ["fn", "viewDatabase"],
];
// FAM bootstrap: real source, so the sandbox is configured the way a page is
const BOOTSTRAP = ["FAM", "NS", "cap1", "TERM", "TERM_TH", "ORD", "RES_KIND", "normKind"];

const vizEsc = chartsSrc.slice(chartsSrc.indexOf("  function esc(s) {"),
  chartsSrc.indexOf("}", chartsSrc.indexOf("return d.innerHTML;")) + 1);
const vizNiceTicks = chartsSrc.slice(chartsSrc.indexOf("  function niceTicks("),
  chartsSrc.indexOf("\n  }", chartsSrc.indexOf("  function niceTicks(")) + 4);

function engine(cfg) {
  const dom = fakeDom();
  const appRoot = cfg.appRoot;
  const charts = [];      // every CCViz.lineChart call the run made
  const spans = BOOTSTRAP.map(n => spanOfConst(n))
    .concat(ENGINE_DEFS.map(([k, n]) => (k === "fn" ? spanOfFn(n) : spanOfConst(n))))
    .sort((a, b) => a[0] - b[0]);
  const body = `
    "use strict";
    // no CadWrapped: the share-card/standings module is a separate script,
    // and the views under test have to behave when it has not loaded
    const window = { APP_CFG: __cfg, CCViz: {} };
    const document = __dom.document;
    const location = { hash: "#/", replace() {} };
    const history = { replaceState() {} };
    const store = () => { const m = new Map(); return {
      getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k) }; };
    const localStorage = store(), sessionStorage = store();
    const fetch = __fetch;
    ${vizEsc}
    ${vizNiceTicks}
    const PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#6741d9", "#c2255c", "#0c8599", "#a61e4d", "#495057"];
    const lineChart = (c, o) => { __charts.push({ via: "lineChart", opts: o }); c.innerHTML = "[lineChart]"; };
    const sparkline = () => {};
    const app = document.getElementById("app");
    const setNav = () => {};
    const corpsColor = () => "#1971c2";
    const corpsPair = () => ({ bar: "#101820", accent: "#f0b429" });
    const _hx = () => [16, 24, 32];
    const _mix = a => a;
    const _rgb = () => "#101820";
    const corpsLogo = () => "<i class='logo'></i>";
    const corpsLink = n => \`<a href="#/corps/\${slugOf(n)}">\${esc(n)}</a>\`;
    const FAVS = { has: () => false, list: () => [], toggle() {} };
    const LIVE = { refresh: () => Promise.resolve(), corpsLive: () => false, showLive: () => false };
    const LIVE_BADGE = "";
    const SHARE_SVG = "";
    const collapseRows = () => {};
    // the shipped selects are re-drivable: the test mutates the very Set the
    // view handed in and calls the view's own onChange, so a filter change is
    // the real code path, not a re-implementation of one
    const multiSelect = (mount, o) => { __selects.push({ mount, opts: o }); return { refresh() {}, setOptions() {}, set() {} }; };
    const singleSelect = (mount, o) => { __selects.push({ mount, opts: o }); return { refresh() {}, setOptions() {}, set() {} }; };
    const CadEnsembles = null;
    ${spans.map(sliceOf).join("\n")}
    return { data, score3, normKind, resultsKind, hasCaptions, lowerIsBetter, bestOf,
             isPlaced, scaleTicks, ratingChart, scoreChart, DB_SETS, dataSubNav,
             viewCorpsHub, renderCorpsDetail, viewDatabase,
             run: s => eval(s) };`;
  const __fetch = url => {
    const rel = url.replace(/^data\//, "");
    const file = path.join(ROOT, appRoot, "data", rel);
    if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("404")) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8"))) });
  };
  const selects = [];
  const api = new Function("__cfg", "__dom", "__fetch", "__charts", "__selects", body)(
    cfg.appCfg || null, dom, __fetch, charts, selects);
  return Object.assign(api, { dom, charts, selects, html: id => dom.el(id).innerHTML });
}


/* ── engines under test ────────────────────────────────────────────────── */
function appCfgOf(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const m = html.match(/window\.APP_CFG = (\{[\s\S]*?\});\s*\n/);
  if (!m) throw new Error("no window.APP_CFG in " + rel);
  return JSON.parse(m[1]);
}
// the shipped UIL page config, verbatim — the sandbox is configured exactly
// the way the browser configures the engine
const uil = () => engine({ appRoot: "docs/uil", appCfg: appCfgOf("docs/uil/index.html") });
// the same built engine with no APP_CFG at all is the DCI app
const dci = () => engine({ appRoot: "docs", appCfg: null });

/* ── reading rendered output back ──────────────────────────────────────── */
const yTicksOf = html => [...html.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
const tilesOf = html => [...html.matchAll(
  /<div class="corpshero-stat"[^>]*><div class="b"><\/div><div class="v">([\s\S]*?)<\/div><div class="l">([\s\S]*?)<\/div><\/div>/g)]
  .map(m => ({ v: m[1], l: m[2] }));
const cellsOf = rowHtml => [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
const rowsOf = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[0]);
const settle = () => new Promise(r => setTimeout(r, 0));
async function until(fn, tries = 60) {
  for (let i = 0; i < tries; i++) { if (fn()) return true; await settle(); }
  return false;
}
// re-drive a shipped multi/single select the way a user would
function pick(e, mountId, values) {
  const ms = e.selects.find(s => s.mount && s.mount.id === mountId);
  if (!ms) throw new Error("no select mounted at #" + mountId);
  if (ms.opts.selected) { ms.opts.selected.clear(); values.forEach(v => ms.opts.selected.add(v)); }
  return ms.opts.onChange(values);
}

/* ══ #21 — a rating is a Division numeral, a placement is a place ════════ */
test("#21 ratings vs placements", () => {
  const e = uil();
  const rows = e.normKind([
    { corps: "Region band", score: null, rating: 1 },
    { corps: "Region band 2", score: null, rating: 3 },
    { corps: "State champion", score: null, placement: 1 },
    { corps: "State 3rd", score: null, placement: 3 },
    { corps: "State 12th", score: null, placement: 12 },
  ]);
  ok(e.score3(rows[0].score) === "I", `rating 1 renders as Division I (got ${e.score3(rows[0].score)})`);
  ok(e.score3(rows[1].score) === "III", `rating 3 renders as Division III (got ${e.score3(rows[1].score)})`);
  ok(e.score3(rows[2].score) === "1st", `State placement 1 renders as 1st (got ${e.score3(rows[2].score)})`);
  ok(e.score3(rows[3].score) === "3rd", `State placement 3 renders as 3rd — NOT Division III (got ${e.score3(rows[3].score)})`);
  ok(e.score3(rows[4].score) === "12th", `State placement 12 renders as 12th (got ${e.score3(rows[4].score)})`);
  ok(e.score3(null) === "—", "null still renders as an em dash");
  ok(e.normKind([{ corps: "x", score: 87.5, rating: 1 }])[0].score === 87.5,
    "a real score survives normKind untouched");
  const p = engine({ appRoot: "docs/uil", appCfg: { ns: "p:", resultsKind: "placement", terms: { singular: "band", plural: "bands", a: "a band" }, classOrder: [] } });
  ok(p.score3(p.normKind([{ corps: "x", score: null, placement: 2 }])[0].score) === "2nd",
    "a pure-placement circuit renders plain ordinals");
  ok(dci().score3(88.25) === "88.250", "DCI still prints three-decimal point scores");
});

/* ══ #25 — the real loader fills the channel a profile row actually has ══ */
test("#25 profile score channel", async () => {
  const e = uil();
  const detail = await e.data("corps/a-c-jones-hs.json");   // real fetch + normKind
  const perfs = detail.performances;
  const rated = perfs.filter(p => p.rating != null);
  const placed = perfs.filter(p => p.placement != null);
  ok(rated.length > 0 && placed.length > 0,
    `the fixture band really has both kinds (${rated.length} rated, ${placed.length} placed)`);
  ok(perfs.filter(p => p.s != null).length === rated.length + placed.length,
    `every rated/placed performance has a profile score (${perfs.filter(p => p.s != null).length} of ${rated.length + placed.length})`);
  ok(rated.every(p => p.s === p.rating), "a region row's `s` is its Division rating");
  ok(placed.every(p => p.s === 1000 + p.placement), "a State row's `s` is the +1000 placement marker");
  ok(e.isPlaced(placed[0].s) && !e.isPlaced(rated[0].s), "isPlaced separates the two scales by value alone");
  ok(e.bestOf(rated.map(p => p.s)) === Math.min(...rated.map(p => p.s)),
    "the profile's best-of picks the lowest rating, not the highest");
  const d = dci();
  ok(d.bestOf([80.1, 92.4, 88]) === 92.4, "on DCI the best score is still the highest");
  ok(d.bestOf([]) === null, "best-of an empty season is null, not 0");
  ok(d.isPlaced(1001) === false, "a DCI score above 1000 is never mistaken for a placement");
});

/* ══ R1 — an ordinal scale is charted on its own domain ══════════════════
   The bug this replaces: CCViz picks gridlines with niceTicks() over the
   PADDED numeric range of whatever is on screen, so score3 as the tick
   formatter rounded fractions onto numerals. 20,343 of the 20,362 UIL
   band-seasons on file have exactly one rated show, which pads to ±1 and
   printed "0 · I · I · II · II". Both halves are asserted here: the ticks
   the shipped renderer produces, and the ticks the old path would have. */
function chartsSnippet(text) {
  ok(chartsSrc.indexOf(text) >= 0, `docs/charts.js still contains: ${text.slice(0, 50)}…`);
  return chartsSrc.indexOf(text) >= 0 ? text : "/* MISSING */";
}
test("R1 rating axis ticks", () => {
  const e = uil();
  const probe = e.dom.el("probe");
  const ticksFor = ys => {
    probe.innerHTML = "";
    e.ratingChart(probe, { series: [{ name: "band", points: ys.map((y, i) => ({ x: i, y })) }] });
    return yTicksOf(probe.innerHTML);
  };
  const WANT = ["I", "II", "III", "IV", "V"];
  for (const ys of [[1, 1, 1], [1, 2], [1, 3], [1, 2, 3, 4, 5], [3], [5, 5]]) {
    const got = ticksFor(ys);
    ok(got.join("·") === WANT.join("·"),
      `series [${ys}] draws the whole Division scale I–V (got ${got.join("·") || "nothing"})`);
  }
  ok(new Set(ticksFor([1, 1, 1])).size === 5, "no numeral is repeated on two gridlines");
  ok(!ticksFor([1, 1, 1]).includes("0"), 'no chart prints a Division "0"');
  // placements keep whole places and start at 1st
  const placeTicks = ys => { probe.innerHTML = ""; e.ratingChart(probe, { series: [{ name: "b", points: ys.map((y, i) => ({ x: i, y })) }] }); return yTicksOf(probe.innerHTML); };
  const pt = placeTicks([1001, 1003]);
  ok(pt[0] === "1st" && !pt.some(t => /^0/.test(t)),
    `a State-placement axis starts at 1st and never at 0th (got ${pt.join("·")})`);
  ok(pt.every(t => /^\d+(st|nd|rd|th)$/.test(t)) && new Set(pt).size === pt.length,
    `every placement tick is a whole, distinct place (got ${pt.join("·")})`);
  // best on top: Division I sits above Division V
  probe.innerHTML = "";
  e.ratingChart(probe, { series: [{ name: "b", points: [{ x: 0, y: 1 }, { x: 1, y: 5 }] }] });
  const ys = [...probe.innerHTML.matchAll(/<text[^>]*y="([\d.]+)"[^>]*text-anchor="end"[^>]*>(I|V)<\/text>/g)];
  const yOf = n => +(ys.find(m => m[2] === n) || [])[1];
  ok(yOf("I") < yOf("V"), `Division I is drawn above Division V (I@${yOf("I")} V@${yOf("V")})`);

  /* the negative control: the same values through docs/charts.js's real tick
     chooser and the shipped score3 — i.e. exactly what shipped before */
  const PAD = chartsSnippet("    const pad = (yMax - yMin) * 0.08 || 1;\n    yMin -= pad; yMax += pad;");
  const LOOP = chartsSnippet("    for (const tv of niceTicks(yMin, yMax, 5)) {\n      if (tv < yMin || tv > yMax) continue;");
  const legacy = e.run(`ys => {
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
${PAD}
    const out = [];
${LOOP}
      out.push(score3(tv));
    }
    return out;
  }`);
  const one = legacy([1, 1, 1]);
  ok(one.includes("0") && new Set(one).size < one.length,
    `the old path really did invent a Division 0 and duplicate numerals (${one.join("·")})`);
  ok(legacy([1, 2]).length > new Set(legacy([1, 2])).size,
    `and repeated numerals on a two-show season too (${legacy([1, 2]).join("·")})`);
});

/* ══ R1 at the call sites — the profile and Compare charts ═══════════════ */
async function profile(e, slug) {
  await e.renderCorpsDetail(slug, () => false);
  return {
    mount: e.html("corpsDetail"), hero: e.html("heroStats"), sub: e.dom.el("heroSub").textContent,
    chart: e.html("corpsChart"), title: e.html("corpsChartTitle"), log: e.html("perfTable"),
  };
}
test("R1 the shipped UIL profile chart", async () => {
  const e = uil();
  const p = await profile(e, "a-c-jones-hs");
  const ticks = yTicksOf(p.chart);
  ok(ticks.join("·") === "I·II·III·IV·V",
    `the default profile chart is labelled I–V (got ${ticks.join("·") || p.chart.slice(0, 60)})`);
  ok(!e.charts.some(c => c.via === "lineChart"),
    "a ratings profile never reaches CCViz.lineChart (which would pick its own ticks)");
  // the all-years view (Best Rating by Year) goes through the same axis
  pick(e, "yearSel2", []);
  const allYears = e.html("corpsChart");
  ok(yTicksOf(allYears).join("·") === "I·II·III·IV·V",
    `Best Rating by Year is labelled I–V too (got ${yTicksOf(allYears).join("·")})`);
  ok(/Best Rating by Year/.test(e.html("corpsChartTitle")),
    "…and that really is the Best Rating by Year view");
  const d = dci();
  await profile(d, "blue-devils");
  ok(d.charts.some(c => c.via === "lineChart"), "a DCI profile still charts through CCViz.lineChart");
});

/* ══ R3 / #29 / #30 — the hero and the tiles a ratings profile renders ═══ */
test("R3 no dead hero tile on a ratings profile", async () => {
  const e = uil();
  const p = await profile(e, "a-c-jones-hs");   // 2025: one rating + one State placement
  const tiles = tilesOf(p.hero);
  ok(tiles.length === 4, `the hero still fills its four-column grid (got ${tiles.length})`);
  ok(!tiles.some(t => /Class rank/.test(t.l)),
    `no "Class rank" tile where standings are computed from point scores this circuit has none of (got ${tiles.map(t => t.l).join(" | ")})`);
  ok(!tiles.some(t => /Improved by/.test(t.l)),
    `no "+0 improved" tile on a one-contest season (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
  ok(!tiles.some(t => /^Shows$/.test(t.l) || /^Rated shows$/.test(t.l)),
    "no \"Shows: 1\" tile on a one-contest season");
  ok(tiles.some(t => t.l === "Season best" && /^(I|II|III|IV|V)$/.test(t.v)),
    `the season tile is the band's best Division numeral (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
  ok(tiles.some(t => t.l === "State finish" && /^\d+(st|nd|rd|th)$/.test(t.v)),
    `the State result gets its own tile as a place (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
  ok(!/…/.test(p.hero), "no tile ships a permanent loading ellipsis");
  // the State tile is the FINISH, not the best of the weekend: Akins HS went
  // 9th in the 2006 prelims and 10th in the finals
  const a = uil();
  await profile(a, "akins-hs");
  pick(a, "yearSel2", ["2006"]);
  const at = tilesOf(a.html("heroStats")).find(t => t.l === "State finish");
  ok(at && at.v === "10th",
    `a prelims-9th / finals-10th season reads 10th, the real finish (got ${at && at.v})`);
  ok(!tiles.some(t => /^\+?-?\d+$/.test(t.v) && /Improved/.test(t.l)), "nothing reads as a bare +0 improvement");
  // #29 — and no dead Share button
  ok(!/id="corpCard"/.test(p.mount), "a ratings profile renders no season-card Share button");
  // #30 — no Caption Scores tile on an app that ships no caption sheets
  ok(!/Caption Scores/.test(p.mount),
    "no Caption Scores tile on a caption-less app (it redirects straight back to Compare)");
  ok(!/#\/captions/.test(p.mount), "and no #/captions link anywhere on the profile");
});

test("R3 the DCI hero is untouched", async () => {
  const d = dci();
  const p = await profile(d, "blue-devils");
  const tiles = tilesOf(p.hero);
  ok(tiles.length === 4, `DCI still renders four hero tiles (got ${tiles.length})`);
  ok(tiles.map(t => t.l).join("|") === "Season high|Class rank|Points gained|Shows",
    `DCI keeps its point-score tiles (got ${tiles.map(t => t.l).join("|")})`);
  ok(/id="corpCard"/.test(p.mount), "DCI still offers the season-card Share button");
  ok(/Caption Scores/.test(p.mount) && /#\/captions\?corps=/.test(p.mount),
    "DCI still offers the Caption Scores tile");
});

/* ══ the six behaviour changes an earlier suite could not see ════════════
   Each block below is written so that reverting exactly one line of
   docs/app.js turns it red. */
test("seasonAgg picks the BEST rating, not the highest number", async () => {
  const e = uil();
  await profile(e, "arlington-hs");
  pick(e, "yearSel2", ["2007"]);              // 2007 = two rated shows, Div II then Div I
  const tiles = tilesOf(e.html("heroStats"));
  const best = tiles.find(t => t.l === "Season best");
  ok(best && best.v === "I",
    `a season of Division II + Division I reads "Season best I" (got ${best && best.v})`);
  const improved = tiles.find(t => t.l === "Improved by");
  ok(improved && improved.v === "+1",
    `and a real two-show season still gets its improvement tile (got ${improved && improved.v})`);
  ok(tiles.some(t => t.l === "Rated shows" && t.v === "2"),
    `…and its show count (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
});

test("seasonAgg keeps State placements off the rating average", async () => {
  const e = uil();
  await profile(e, "a-c-jones-hs");
  pick(e, "yearSel2", ["2025"]);              // one region rating + one State placement
  const tiles = tilesOf(e.html("heroStats"));
  ok(!tiles.some(t => /Improved by/.test(t.l)),
    `the State row is not counted as a second rated show (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
  ok(!tiles.some(t => Math.abs(+String(t.v).replace("+", "")) > 100),
    `no tile prints a cross-scale ±1000 (got ${tiles.map(t => `${t.v}/${t.l}`).join(" | ")})`);
});

test("the performance log never subtracts across the two scales", async () => {
  const e = uil();
  await profile(e, "a-c-jones-hs");
  pick(e, "yearSel2", []);                    // whole career, both scales in one table
  const log = e.html("perfTable");
  const deltas = [...log.matchAll(/<span class="delta ([a-z]+)">([^<]*)<\/span>/g)].map(m => m[2].trim());
  ok(deltas.length > 0, `the log renders a vs-prev column (${deltas.length} cells)`);
  ok(!deltas.some(d => /\d{3,}/.test(d)),
    `no vs-prev cell shows a ±1000 cross-scale delta (worst: ${deltas.filter(d => /\d{3,}/.test(d)).slice(0, 3).join(",") || "none"})`);
  ok(deltas.some(d => d === "—"), "a row with nothing comparable before it shows an em dash");
});

test("Best Rating by Year plots each season's BEST rating", async () => {
  const e = uil();
  await profile(e, "arlington-hs");
  pick(e, "yearSel2", []);                    // all years → the by-season chart
  const html = e.html("corpsChart");
  ok(/Best Rating by Year/.test(e.html("corpsChartTitle")), "the by-season view is on screen");
  const detail = await e.data("corps/arlington-hs.json");
  const byYear = new Map();
  detail.performances.forEach(p => {
    if (p.s == null || e.isPlaced(p.s)) return;
    byYear.set(p.y, Math.min(byYear.has(p.y) ? byYear.get(p.y) : 9, p.s));
  });
  // the plotted point for 2007 must be Division I (the best), not II (the max)
  const want = byYear.get(2007);
  ok(want === 1, `2007 really has a better and a worse rating (best ${want})`);
  const plotted = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]);
  const p2007 = plotted.find(t => /2007/.test(t));
  ok(p2007 && /·\s*I$/.test(p2007), `2007 plots as Division I, not II (got ${p2007})`);
  ok(plotted.length === byYear.size,
    `every season with a rating is plotted once (${plotted.length} of ${byYear.size})`);
});

/* ══ #27 — the Database renders (and sorts) the column the rows carry ════ */
test("#27 the Database Scores set", async () => {
  const e = uil();
  await e.viewDatabase(null, () => false);
  ok(await until(() => /<table/.test(e.html("dbtable"))), "the Database renders a table");
  const html = e.html("dbtable");
  const headers = [...html.matchAll(/<th[^>]*data-c="(\d+)"[^>]*>([^<↑↓]*)/g)].map(m => [+m[1], m[2].trim()]);
  ok(headers.some(h => h[1] === "Rating"), `the last column is headed Rating (got ${headers.map(h => h[1]).join("|")})`);
  ok(!headers.some(h => h[1] === "Score"), "the always-null Score column is gone");
  const ratingCol = headers.findIndex(h => h[1] === "Rating");
  const body = rowsOf(html).filter(r => /<td/.test(r));
  ok(body.length > 0, `rows rendered (${body.length})`);
  // column alignment on a row whose raw values we know: the freshest UIL row
  // is a 2025 State finals placement, which carries no region rating
  const first = cellsOf(body[0]);
  ok(/2025/.test(first[0]) && /Nov/.test(first[1]) && /State Marching Band Championships/.test(first[2]),
    `the newest row lines its cells up with the raw row (${first.slice(0, 3).join(" / ")})`);
  ok(/^\d+$/.test(first[5]), `the Place column holds a place (got ${first[5]})`);
  // the raw rows behind it
  const rows = readJson("docs/uil/data/db/perfs_2010s.json");
  ok(rows[0].length === 8 && rows.every(r => r[6] == null),
    "the raw rows really do carry a null Score in column 6 and the rating in column 7");
  ok(rows.some(r => r[7] >= 1 && r[7] <= 5), "…and a real Division rating in column 7");

  /* #27 nit — first click on Rating sorts best-first (Division I), because a
     rating is a golf score. Driven through the shipped header handler. */
  const th = e.dom.document.querySelectorAll("#dbtable th").find(t => +t.dataset.c === 7);
  ok(!!th, "the Rating header is clickable");
  th.onclick();
  await until(() => true);
  const sorted = rowsOf(e.html("dbtable")).filter(r => /<td/.test(r)).map(r => cellsOf(r)[ratingCol]);
  ok(sorted.every(v => /^(I|II|III|IV|V)$/.test(v)),
    `sorted by Rating, every rendered cell in that column is a Division numeral — not the always-null Score column (got ${[...new Set(sorted)].join(",")})`);
  ok(sorted[0] === "I", `the first click on Rating opens on Division I, not Division V (got ${sorted[0]})`);
  ok(/data-c="7"[^>]*>Rating ↑/.test(e.html("dbtable")), "and the header shows an ascending arrow");
  // clicking again still reverses
  e.dom.document.querySelectorAll("#dbtable th").find(t => +t.dataset.c === 7).onclick();
  await until(() => true);
  const rev = rowsOf(e.html("dbtable")).filter(r => /<td/.test(r)).map(r => cellsOf(r)[ratingCol]);
  ok(rev[0] !== "I", `a second click reverses it (got ${rev[0]})`);

  const d = dci();
  await d.viewDatabase(null, () => false);
  ok(await until(() => /<table/.test(d.html("dbtable"))), "the DCI Database renders");
  const dh = [...d.html("dbtable").matchAll(/<th[^>]*data-c="(\d+)"[^>]*>([^<↑↓]*)/g)].map(m => m[2].trim());
  ok(dh[dh.length - 1] === "Score", `DCI keeps its Score column (got ${dh.join("|")})`);
  const dth = d.dom.document.querySelectorAll("#dbtable th").find(t => +t.dataset.c === 6);
  dth.onclick();
  await until(() => true);
  const dcol = rowsOf(d.html("dbtable")).filter(r => /<td/.test(r)).map(r => cellsOf(r)[6]);
  ok(+dcol[0] >= +dcol[1], `DCI's Score column still opens on the highest score (${dcol.slice(0, 2).join(" then ")})`);
});

/* ══ #24 + R6 — Compare keeps the scales apart and says what it expands ══ */
test("#24 Compare charts one scale and names it", async () => {
  const e = uil();
  await e.viewCorpsHub("c=a-c-jones-hs&y=2025", () => false);
  ok(await until(() => /<table/.test(e.html("cmpTable"))), "Compare renders its summary table");
  const ticks = yTicksOf(e.html("cmpChart"));
  ok(ticks.join("·") === "I·II·III·IV·V",
    `the Compare chart is labelled I–V, with no fabricated 0 (got ${ticks.join("·")})`);
  ok(!e.charts.some(c => c.via === "lineChart"), "Compare never hands a ratings selection to CCViz.lineChart");
  const table = e.html("cmpTable");
  ok(/title="Tap for every region rating that season"/.test(table),
    `the row promises the scale it expands into (title: ${(table.match(/title="([^"]*)"/) || [])[1]})`);
  ok(!/Tap for every show that season/.test(table), "…and no longer promises every show");
  ok(/switch <b>Results<\/b> above to list/.test(table),
    "a row with results on the other scale says so inside its own expansion");
  ok(/State placement/.test(table), "and names that other scale");
  // the global notice still counts them too
  ok(/sit on the other scale/.test(e.html("cmpNotice")), "the global off-scale notice still fires");
  // switching the scale switches both the chart and the promise
  pick(e, "cmpKind", "placement");
  ok(await until(() => /Tap for every State placement that season/.test(e.html("cmpTable"))),
    "switching Results re-promises State placements");
  const pTicks = yTicksOf(e.html("cmpChart"));
  ok(pTicks.every(t => /^\d+(st|nd|rd|th)$/.test(t)) && pTicks[0] === "1st",
    `the placement view charts places (got ${pTicks.join("·")})`);

  const d = dci();
  await d.viewCorpsHub("c=blue-devils&y=2024", () => false);
  ok(await until(() => /<table/.test(d.html("cmpTable"))), "DCI Compare still renders");
  ok(/title="Tap for every show that season"/.test(d.html("cmpTable")),
    "DCI keeps the plain every-show promise");
  ok(d.charts.some(c => c.via === "lineChart"), "and still charts through CCViz.lineChart");
});

test("#24 the Gain column reads as an improvement", () => {
  const e = uil();
  const GAIN = snippet("gain: (lowerIsBetter() ? -drift : drift).toFixed(lowerIsBetter() ? 0 : 2),");
  const gainOf = e.run(`scores => {
    const drift = scores[scores.length - 1] - scores[0];
    return ({ ${GAIN} }).gain;
  }`);
  ok(gainOf([3, 1]) === "2", `a band that went Division III → I gained 2 (got ${gainOf([3, 1])})`);
  ok(gainOf([1, 3]) === "-2", `a band that slid Division I → III gained -2 (got ${gainOf([1, 3])})`);
  ok(gainOf([1, 1]) === "0", `a band that held Division I gained 0 (got ${gainOf([1, 1])})`);
  const dciGain = dci().run(`scores => {
    const drift = scores[scores.length - 1] - scores[0];
    return ({ ${GAIN} }).gain;
  }`);
  ok(dciGain([80.5, 92.75]) === "12.25", `DCI still gains points, two decimals (got ${dciGain([80.5, 92.75])})`);
});

/* ══ #28 — Biggest One-Season Leaps is not inverted for ratings ══════════ */
test("#28 leaps", () => {
  snippet("const lb = lowerIsBetter();");
  const LEAP = snippet("const dlt = +(lb ? b1 - b2 : b2 - b1).toFixed(3);");
  const e = uil();
  const leap = e.run(`(b1, b2) => { const lb = lowerIsBetter(); ${LEAP} return dlt; }`);
  ok(leap(4, 1) === 3, `Division IV → I is a +3 leap (got ${leap(4, 1)})`);
  ok(leap(1, 4) === -3, `Division I → IV is NOT a leap (got ${leap(1, 4)})`);
  const idx = readJson("docs/uil/data/corps_index.json");
  const leaps = [];
  idx.forEach(c => {
    const series = (c.series || []).slice().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < series.length; i++) {
      const [y1, b1] = series[i - 1], [y2, b2] = series[i];
      if (y2 !== y1 + 1 || b1 == null || b2 == null) continue;
      const d = leap(b1, b2);
      if (d > 0) leaps.push({ corps: c.name, b1, b2, d });
    }
  });
  leaps.sort((a, b) => b.d - a.d);
  ok(leaps.length > 0, `the real UIL index yields leaps to rank (${leaps.length})`);
  ok(leaps.every(l => l.b2 < l.b1), "every celebrated leap is a band whose rating got BETTER");
  const dciLeap = dci().run(`(b1, b2) => { const lb = lowerIsBetter(); ${LEAP} return dlt; }`);
  ok(dciLeap(80, 90) === 10 && dciLeap(90, 80) === -10, "DCI still leaps upward in points");
});

/* ══ #30 — no Caption Scores dataset where the app ships no captions ═════ */
test("#30 caption-less apps", () => {
  const SETS = snippet('const dbSets = Object.entries(DB_SETS).filter(([k]) => k !== "captions" || hasCaptions());');
  const labels = env => env.run(`(() => { ${SETS} return dbSets.map(([, v]) => v.label); })()`);
  ok(labels(uil()).join("|") === "Scores", `a caption-less circuit offers only Scores (got ${labels(uil()).join("|")})`);
  const capped = engine({ appRoot: "docs/ffcc", appCfg: appCfgOf("docs/ffcc/index.html") });
  ok(labels(capped).indexOf("Caption Scores") >= 0, "a circuit with caption sheets still offers Caption Scores");
  ok(labels(dci()).indexOf("Caption Scores") >= 0, "DCI still offers Caption Scores");
  const noCaps = ["uil", "usbands", "wgi/guard", "wgi/percussion", "wgi/winds"];
  ok(noCaps.every(a => !fs.existsSync(path.join(ROOT, "docs", a, "data", "captions"))),
    "the five apps we hide the dataset on really ship no captions data");
  ok(["boa", "ffcc", "tcgc", "wgasc"].every(a => fs.existsSync(path.join(ROOT, "docs", a, "data", "captions"))),
    "the four that keep it really do ship captions data");
  // …and the Stats sub-nav does not offer a Captions tab it would bounce off
  ok(!/Captions/.test(uil().dataSubNav("compare")), "no Captions tab in the Stats sub-nav either");
  ok(/Captions/.test(dci().dataSubNav("compare")), "DCI keeps its Captions tab");
});

/* ══ #26 — the Alerts card covers every app in the registry ══════════════ */
test("#26 alerts registry", () => {
  const regSrc = fs.readFileSync(path.join(ROOT, "docs", "registry.js"), "utf8");
  const apps = new Function(`const window = {}; ${regSrc}
    return (${extract("CAD_APPS")});`)();
  const registry = new Function(`const window = {}; ${regSrc}; return window.CAD_REGISTRY.apps;`)();
  ok(registry.length === 10, `the registry really lists 10 apps (got ${registry.length})`);
  ok(apps.length === registry.length, `the Alerts card covers all ${registry.length} apps (got ${apps.length})`);
  ok(registry.every(r => apps.some(a => a.ns === r.ns)), "every registry namespace has an alerts row");
  ok(apps.every(a => !/\/$/.test(a.path)), "no alerts row builds a double-slashed data URL");
  ok(apps[0].name === "Cadence DCI" && apps[0].path === ".", "DCI keeps its own name and root path");
  const fallback = new Function(`const window = {}; return (${extract("CAD_APPS")});`)();
  ok(fallback.length === 4 && fallback[0].ns === "", "the no-registry fallback still degrades to the DCI + WGI list");
});

/* ── run ────────────────────────────────────────────────────────────────── */
(async () => {
  for (const [name, fn] of SECTIONS) {
    try { await fn(); }
    catch (e) { fail.push(`${name}: threw ${(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)}`); }
  }
  console.log(`PASS ${pass.length}`);
  pass.forEach(m => console.log("  ok   " + m));
  if (fail.length) {
    console.log(`FAIL ${fail.length}`);
    fail.forEach(m => console.log("  FAIL " + m));
    process.exit(1);
  }
})();
