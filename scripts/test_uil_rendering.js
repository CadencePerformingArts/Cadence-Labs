#!/usr/bin/env node
/* Fixture tests for the ratings/placements circuits (UIL) in the derived
 * family engine.
 *
 *   node scripts/test_uil_rendering.js
 *
 * Everything under test is pulled out of the BUILT engine
 * (docs/family/app.js) — never reimplemented here — and driven against the
 * real shipped UIL data files, so a regression in docs/app.js or in
 * scripts/build_family_engine.py fails this file.
 *
 * Covers:
 *   #21  State placements render as places ("3rd"), never as Division
 *        ratings ("III")
 *   #25  normKind fills the score channel the row actually has — corps
 *        profiles key performances on `s`, not `score`
 *   #24  Compare never charts Division ratings and State placements on one
 *        axis, and the Gain column reads as an improvement
 *   #27  the Database Scores set shows the Rating column the rows carry
 *        instead of an always-null Score column
 *   #28  "Biggest One-Season Leaps" ranks a DROP in rating as the leap
 *   #26  the Alerts card covers every app in docs/registry.js
 *   #29  no season-card Share button where there are no point scores
 *   #30  no Caption Scores dataset where the app ships no captions
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "docs", "family", "app.js"), "utf8");
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// pull the exact definitions out of the built engine (brace-aware, since
// normKind spans multiple lines)
function extract(name) {
  const tag = `const ${name} = `;
  const start = src.indexOf(tag);
  if (start < 0) throw new Error(`could not find ${name} in the built engine`);
  let i = start + tag.length, depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) break;
  }
  return src.slice(start + tag.length, i);
}
// the same, for a `function name(...) { ... }` declaration
function extractFn(name) {
  const tag = `function ${name}(`;
  const start = src.indexOf(tag);
  if (start < 0) throw new Error(`could not find function ${name} in the built engine`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}
// a literal line of shipped source, asserted present so a reverted fix fails
// here instead of quietly passing a reimplementation
function snippet(text) {
  if (src.indexOf(text) < 0) throw new Error(`the built engine no longer contains: ${text.slice(0, 70)}`);
  return text;
}

/* A sandbox holding the engine's real ratings helpers, plus `run` for
   evaluating a shipped snippet inside that same scope. */
function build(resKind, captions) {
  const ctx = `const FAM = { resultsKind: ${JSON.stringify(resKind)}, captions: ${!!captions} };
    const ORD = ${extract("ORD")};
    const RES_KIND = FAM ? FAM.resultsKind : null;
    const normKind = ${extract("normKind")};
    const score3 = ${extract("score3")};
    ${extractFn("resultsKind")}
    ${extractFn("hasCaptions")}
    const lowerIsBetter = ${extract("lowerIsBetter")};
    const bestOf = ${extract("bestOf")};
    const isPlaced = ${extract("isPlaced")};
    function loadScores() {}
    function loadCaptionRows() {}
    const DB_SETS = ${extract("DB_SETS")};
    return { normKind, score3, resultsKind, hasCaptions, lowerIsBetter, bestOf,
             isPlaced, DB_SETS, run: s => eval(s) };`;
  return new Function(ctx)();
}
// the DCI app runs with no FAM at all — same source, RES_KIND null
function buildDci() {
  const ctx = `const FAM = null;
    const ORD = ${extract("ORD")};
    const RES_KIND = FAM ? FAM.resultsKind : null;
    const score3 = ${extract("score3")};
    ${extractFn("resultsKind")}
    ${extractFn("hasCaptions")}
    const lowerIsBetter = ${extract("lowerIsBetter")};
    const bestOf = ${extract("bestOf")};
    const isPlaced = ${extract("isPlaced")};
    function loadScores() {}
    function loadCaptionRows() {}
    const DB_SETS = ${extract("DB_SETS")};
    return { score3, resultsKind, hasCaptions, lowerIsBetter, bestOf, isPlaced,
             DB_SETS, run: s => eval(s) };`;
  return new Function(ctx)();
}

// ── #21 — UIL (resultsKind 'rating'): region ratings vs State placements ──
{
  const { normKind, score3 } = build("rating");
  const rows = normKind([
    { corps: "Region band", score: null, rating: 1 },
    { corps: "Region band 2", score: null, rating: 3 },
    { corps: "State champion", score: null, placement: 1 },
    { corps: "State 3rd", score: null, placement: 3 },
    { corps: "State 12th", score: null, placement: 12 },
  ]);
  ok(score3(rows[0].score) === "I", `rating 1 renders as Division I (got ${score3(rows[0].score)})`);
  ok(score3(rows[1].score) === "III", `rating 3 renders as Division III (got ${score3(rows[1].score)})`);
  ok(score3(rows[2].score) === "1st", `State placement 1 renders as 1st (got ${score3(rows[2].score)})`);
  ok(score3(rows[3].score) === "3rd", `State placement 3 renders as 3rd — NOT Division III (got ${score3(rows[3].score)})`);
  ok(score3(rows[4].score) === "12th", `State placement 12 renders as 12th (got ${score3(rows[4].score)})`);
  ok(score3(null) === "—", "null still renders as an em dash");
}

// ── pure placement circuits keep plain ordinals ─────────────────────────
{
  const { normKind, score3 } = build("placement");
  const rows = normKind([{ corps: "x", score: null, placement: 2 }]);
  ok(score3(rows[0].score) === "2nd", `placement circuit renders 2nd (got ${score3(rows[0].score)})`);
}

// ── an existing real score is never overwritten by normKind ─────────────
{
  const { normKind } = build("rating");
  const rows = normKind([{ corps: "x", score: 87.5, rating: 1 }]);
  ok(rows[0].score === 87.5, "a real score survives normKind untouched");
}

/* ── #25 — corps profiles key performances on `s`, not `score` ──────────
   Every view but the profile reads `score`; the profile reads `p.s`, which
   ships null on all 24,745 UIL performances. Drive normKind with the real
   file and prove the profile's channel is filled. */
{
  const { normKind, score3, bestOf, isPlaced } = build("rating");
  const detail = normKind(readJson("docs/uil/data/corps/a-c-jones-hs.json"));
  const perfs = detail.performances;
  const rated = perfs.filter(p => p.rating != null);
  const placed = perfs.filter(p => p.placement != null);
  ok(rated.length > 0 && placed.length > 0,
    `the fixture band really has both kinds (${rated.length} rated, ${placed.length} placed)`);
  ok(perfs.filter(p => p.s != null).length === rated.length + placed.length,
    `every rated/placed performance has a profile score (${perfs.filter(p => p.s != null).length} of ${rated.length + placed.length})`);
  ok(rated.every(p => p.s === p.rating), "a region row's `s` is its Division rating");
  ok(placed.every(p => p.s === 1000 + p.placement), "a State row's `s` is the +1000 placement marker");
  ok(score3(rated[0].s) === "I" || /^(I|II|III|IV|V)$/.test(score3(rated[0].s)),
    `the profile log renders a region row as a Division numeral (got ${score3(rated[0].s)})`);
  ok(/^\d+(st|nd|rd|th)$/.test(score3(placed[0].s)),
    `the profile log renders a State row as an ordinal (got ${score3(placed[0].s)})`);
  // "Best score" must be the band's best, i.e. the LOWEST rating
  ok(bestOf(rated.map(p => p.s)) === Math.min(...rated.map(p => p.s)),
    "the profile's best-of picks the lowest rating, not the highest");
  ok(isPlaced(placed[0].s) && !isPlaced(rated[0].s),
    "isPlaced separates the two scales by value alone");
  // the profile's scale helpers are `const`s used inside the hero template
  // that renders further down the same function — declared after it, every
  // UIL profile would die in the temporal dead zone instead of rendering
  ok(src.indexOf("const scoreNoun = resultsKind() === \"rating\"") <
     src.indexOf("${lowerIsBetter() ? \"Best \" + scoreNoun : \"Best score\"}"),
    "the profile declares its scale helpers before the hero that uses them");
  ok(src.indexOf("const chartPts = ps =>") < src.indexOf("function renderChart()"),
    "and before the chart that uses them");
}
{
  const { bestOf, isPlaced } = buildDci();
  ok(bestOf([80.1, 92.4, 88]) === 92.4, "on DCI the best score is still the highest");
  ok(bestOf([]) === null, "best-of an empty season is null, not 0");
  ok(isPlaced(1001) === false, "a DCI score above 1000 is never mistaken for a placement");
}

/* ── #24 — Compare keeps the two scales off one axis ────────────────────
   The shipped collector line and Gain expression, run over the real 2019
   UIL season (region ratings + State placements in the same file). */
{
  const env = build("rating");
  const FILTER = snippet('if (twoScales && (isPlaced(r.score) ? "placement" : "rating") !== scaleSel) { offScale++; continue; }');
  const collect = env.run(`(rows, twoScales, scaleSel) => {
    let offScale = 0; const kept = [];
    for (const r of rows) { ${FILTER} kept.push(r.score); }
    return { kept, offScale };
  }`);
  const season = env.normKind(readJson("docs/uil/data/seasons/2019.json"));
  const all = [];
  season.forEach(ev => (ev.classes || []).forEach(c => (c.results || []).forEach(r => { if (r.score) all.push(r); })));
  const ratings = collect(all, true, "rating");
  const places = collect(all, true, "placement");
  ok(all.length > 0 && ratings.kept.length > 0 && places.kept.length > 0,
    `2019 really mixes both scales (${ratings.kept.length} ratings, ${places.kept.length} placements)`);
  ok(ratings.kept.every(v => v < 1000), "the ratings view charts no 1000+ placement value");
  ok(places.kept.every(v => v >= 1000), "the placements view charts no Division rating");
  ok(ratings.kept.length + places.kept.length === all.length,
    "nothing is dropped — every result is on one view or the other");
  ok(ratings.offScale === places.kept.length && places.offScale === ratings.kept.length,
    "the off-scale count reported to the user matches what the other view holds");
  // an unfiltered chart would span 1 → 1000+; each view spans one scale
  const span = v => Math.max(...v) - Math.min(...v);
  ok(span(ratings.kept) < 10 && span(places.kept) < 200 && span(all.map(r => r.score)) > 900,
    `each view charts one scale (mixed span ${span(all.map(r => r.score))})`);

  const GAIN = snippet("gain: (lowerIsBetter() ? -drift : drift).toFixed(lowerIsBetter() ? 0 : 2),");
  const gainOf = env.run(`scores => {
    const drift = scores[scores.length - 1] - scores[0];
    return ({ ${GAIN} }).gain;
  }`);
  ok(gainOf([3, 1]) === "2", `a band that went Division III → I gained 2 (got ${gainOf([3, 1])})`);
  ok(gainOf([1, 3]) === "-2", `a band that slid Division I → III gained -2 (got ${gainOf([1, 3])})`);
  ok(gainOf([1, 1]) === "0", `a band that held Division I gained 0 (got ${gainOf([1, 1])})`);
  // the old bug in full: a band whose season opened on a region rating and
  // closed on a State placement had those two subtracted. Walk every band in
  // the real 2019 season both ways round.
  const byBand = new Map();
  season.forEach(ev => (ev.classes || []).forEach(c => (c.results || []).forEach(r => {
    if (!r.score || !ev.date) return;
    const list = byBand.get(r.corps) || byBand.set(r.corps, []).get(r.corps);
    list.push({ d: ev.date, score: r.score });
  })));
  const seasonsOf = view => [...byBand.values()].map(list => collect(
    list.slice().sort((a, b) => a.d.localeCompare(b.d)), true, view).kept).filter(v => v.length);
  const unfiltered = [...byBand.values()]
    .map(list => list.slice().sort((a, b) => a.d.localeCompare(b.d)).map(p => p.score));
  ok(unfiltered.some(v => Math.abs(+gainOf(v)) > 900),
    "the real 2019 data does contain bands the old cross-scale Gain blew up on");
  ok(seasonsOf("rating").concat(seasonsOf("placement")).every(v => Math.abs(+gainOf(v)) < 900),
    "no band-season on either view can produce a cross-scale Gain any more");

  const dci = buildDci();
  const dciGain = dci.run(`scores => {
    const drift = scores[scores.length - 1] - scores[0];
    return ({ ${GAIN} }).gain;
  }`);
  ok(dciGain([80.5, 92.75]) === "12.25", `DCI still gains points, two decimals (got ${dciGain([80.5, 92.75])})`);
}

/* ── #27 — the Database Scores set shows the column the rows carry ──────
   UIL perf rows are 8 wide: the 7th is an always-null Score, the 8th is the
   Division rating the DCI column list dropped. */
{
  const env = build("rating");
  const ADAPT = snippet(`      if (setKey === "scores" && resultsKind() && rows.length && rows[0].length > cfg.cols.length) {
        const extra = rows[0].length - 1;
        cfg = Object.assign({}, cfg, {
          cols: cfg.cols.slice(0, -1).concat(resultsKind() === "rating" ? "Rating" : "Placement"),
          scoreCols: [extra],
        });
        colIx = colIx.slice(0, -1).concat(extra);
      }`);
  const adapt = env.run(`(setKey, rows) => {
    let cfg = DB_SETS[setKey];
    let colIx = cfg.cols.map((_, i) => i);
${ADAPT}
    return { cols: cfg.cols, scoreCols: cfg.scoreCols, colIx };
  }`);
  const rows = readJson("docs/uil/data/db/perfs_2010s.json");
  ok(rows.length > 0 && rows[0].length === 8, `UIL db rows really are 8 wide (got ${rows[0] && rows[0].length})`);
  ok(rows.every(r => r[6] == null), "column 6 (Score) really is null on every UIL row");
  const got = adapt("scores", rows);
  ok(got.cols.indexOf("Score") < 0, `the always-empty Score column is gone (cols: ${got.cols.join("|")})`);
  ok(got.cols[got.cols.length - 1] === "Rating", "the last column is Rating");
  ok(got.colIx[got.colIx.length - 1] === 7, `that column reads row index 7 (got ${got.colIx[got.colIx.length - 1]})`);
  ok(got.scoreCols[0] === 7, "the score-styled/sorted column is the rating column");
  // what the table cell and the CSV cell both resolve to
  const shown = rows.map(r => r[got.colIx[got.colIx.length - 1]]).filter(v => v != null);
  ok(shown.length > 0 && shown.every(v => v >= 1 && v <= 5),
    `the rendered column holds real Division ratings (${shown.length} of ${rows.length} rows)`);
  ok(env.score3(shown[0]) === ["", "I", "II", "III", "IV", "V"][shown[0]],
    `and renders as a Division numeral (got ${env.score3(shown[0])})`);

  const dci = buildDci();
  const dciAdapt = dci.run(`(setKey, rows) => {
    let cfg = DB_SETS[setKey];
    let colIx = cfg.cols.map((_, i) => i);
${ADAPT}
    return { cols: cfg.cols, colIx };
  }`);
  const dciRows = readJson("docs/data/db/perfs_2010s.json");
  const dciGot = dciAdapt("scores", dciRows);
  ok(dciGot.cols[dciGot.cols.length - 1] === "Score", "DCI keeps its Score column");
  ok(dciGot.colIx.every((v, i) => v === i), "DCI keeps the identity column mapping");
}

/* ── #28 — Biggest One-Season Leaps is not inverted for ratings ─────────*/
{
  snippet("const lb = lowerIsBetter();");
  const LEAP = snippet("const dlt = +(lb ? b1 - b2 : b2 - b1).toFixed(3);");
  const env = build("rating");
  const leap = env.run(`(b1, b2) => { const lb = lowerIsBetter(); ${LEAP} return dlt; }`);
  ok(leap(4, 1) === 3, `Division IV → I is a +3 leap (got ${leap(4, 1)})`);
  ok(leap(1, 4) === -3, `Division I → IV is NOT a leap (got ${leap(1, 4)})`);
  ok(leap(2, 1) > 0 && leap(1, 2) < 0, "the sign follows improvement, not the raw number");
  // rank the real index the way the card does and check the top entry improved
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
  ok(leaps[0].b2 < leaps[0].b1,
    `the headline leap improved: ${leaps[0].corps} ${leaps[0].b1} → ${leaps[0].b2}`);

  const dciLeap = buildDci().run(`(b1, b2) => { const lb = lowerIsBetter(); ${LEAP} return dlt; }`);
  ok(dciLeap(80, 90) === 10 && dciLeap(90, 80) === -10, "DCI still leaps upward in points");
}

/* ── #30 — no Caption Scores dataset where the app ships no captions ────*/
{
  const SETS = snippet('const dbSets = Object.entries(DB_SETS).filter(([k]) => k !== "captions" || hasCaptions());');
  const labels = env => env.run(`(() => { ${SETS} return dbSets.map(([, v]) => v.label); })()`);
  ok(labels(build("rating", false)).join("|") === "Scores",
    `a caption-less circuit offers only Scores (got ${labels(build("rating", false)).join("|")})`);
  ok(labels(build(null, true)).indexOf("Caption Scores") >= 0,
    "a circuit with caption sheets still offers Caption Scores");
  ok(labels(buildDci()).indexOf("Caption Scores") >= 0, "DCI still offers Caption Scores");
  // and the five caption-less apps really have no captions directory
  const noCaps = ["uil", "usbands", "wgi/guard", "wgi/percussion", "wgi/winds"];
  ok(noCaps.every(a => !fs.existsSync(path.join(ROOT, "docs", a, "data", "captions"))),
    "the five apps we hide the dataset on really ship no captions data");
  ok(["boa", "ffcc", "tcgc", "wgasc"].every(a => fs.existsSync(path.join(ROOT, "docs", a, "data", "captions"))),
    "the four that keep it really do ship captions data");
}

/* ── #29 — no dead Share button where there are no point scores ─────────*/
{
  snippet('${resultsKind() ? "" : `<button id="corpCard" class="ch-btn" title="Share this');
  ok(build("rating").run('resultsKind() ? "" : "button"') === "",
    "a ratings circuit renders no season-card Share button");
  ok(buildDci().run('resultsKind() ? "" : "button"') === "button",
    "DCI still renders its Share button");
}

/* ── #26 — the Alerts card covers every app in the registry ─────────────*/
{
  const regSrc = fs.readFileSync(path.join(ROOT, "docs", "registry.js"), "utf8");
  const apps = new Function(`const window = {}; ${regSrc}
    return (${extract("CAD_APPS")});`)();
  const registry = new Function(`const window = {}; ${regSrc}; return window.CAD_REGISTRY.apps;`)();
  ok(registry.length === 10, `the registry really lists 10 apps (got ${registry.length})`);
  ok(apps.length === registry.length,
    `the Alerts card covers all ${registry.length} apps, not 4 (got ${apps.length})`);
  ok(registry.every(r => apps.some(a => a.ns === r.ns)), "every registry namespace has an alerts row");
  ok(apps.every(a => !/\/$/.test(a.path)), "no alerts row builds a double-slashed data URL");
  ok(apps[0].name === "Cadence DCI" && apps[0].path === ".", "DCI keeps its own name and root path");
  ok(apps.some(a => a.ns === "uil:") && apps.some(a => a.ns === "ffcc:"),
    "the circuits that had nowhere to configure alerts now have a row");
  // the fallback literal must still be a valid list if registry.js is missing
  const fallback = new Function(`const window = {}; return (${extract("CAD_APPS")});`)();
  ok(fallback.length === 4 && fallback[0].ns === "",
    "the no-registry fallback still degrades to the DCI + WGI list");
}

console.log(`PASS ${pass.length}`);
pass.forEach((m) => console.log("  ok   " + m));
if (fail.length) {
  console.log(`FAIL ${fail.length}`);
  fail.forEach((m) => console.log("  FAIL " + m));
  process.exit(1);
}
