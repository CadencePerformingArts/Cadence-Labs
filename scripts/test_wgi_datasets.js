#!/usr/bin/env node
/* The WGI datasets are DERIVED. Prove they are still only what was published.
 *
 * docs/wgi/<activity>/data/{corps_index,records,rankings}.json, corps/*.json
 * and db/* are all fanned out of champions.json by
 * scripts/build_wgi_datasets.py, so the app can render WGI through the DCI
 * views. That derivation is exactly the kind of code that grows a plausible
 * number: an averaged score, a filled-in date, an ensemble credited with a
 * season it never won. scripts/purge_fabricated.py exists because that
 * happened here once already.
 *
 * So this suite re-derives nothing and trusts nothing. It reads
 * champions.json, builds the set of real (year, class, champion, score)
 * tuples, and requires every row in every derived file to be one of them —
 * then checks the counts against what WGI actually published, and that the
 * builder is idempotent and refuses to clobber a richer real ingest.
 *
 *   node scripts/test_wgi_datasets.js
 *   node scripts/test_wgi_datasets.js --corrupt   # prove the guards go red
 *
 * --corrupt copies the tree to a scratch directory, plants five specific
 * fabrications in it, and asserts each one is caught.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass.push(msg) : fail.push(msg));

// what WGI has actually published, counted by hand off wgi.org's record and
// asserted here so a silent data change can never pass unnoticed
const EXPECT = {
  "wgi/guard": { seasons: 47, titles: 236, winners: 152, classes: 6, first: 1978, last: 2026 },
  "wgi/percussion": { seasons: 32, titles: 172, winners: 104, classes: 6, first: 1993, last: 2026 },
  "wgi/winds": { seasons: 10, titles: 39, winners: 21, classes: 4, first: 2015, last: 2026 },
};
const EVENT = "WGI World Championships";

/* mirrors slugOf() in docs/app.js — the router only matches [a-z0-9-]+ */
const slugOf = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* every real title in one app, as a lookup key */
function titlesOf(dataDir) {
  const champs = readJson(path.join(dataDir, "champions.json"));
  const rows = [];
  for (const [y, byCls] of Object.entries(champs))
    for (const [cls, w] of Object.entries(byCls))
      rows.push({ year: +y, cls, corps: w.corps, score: w.score == null ? null : +w.score });
  return rows;
}
const key = (y, cls, corps, score) => `${y}|${cls}|${corps}|${score}`;

/* ── the checks, run against any data directory ───────────────────────── */
function checkApp(app, dataDir, report) {
  const say = (cond, msg) => report(cond, `${app}: ${msg}`);
  const titles = titlesOf(dataDir);
  const real = new Set(titles.map((t) => key(t.year, t.cls, t.corps, t.score)));
  const exp = EXPECT[app];
  const years = [...new Set(titles.map((t) => t.year))];
  const winners = new Set(titles.map((t) => t.corps));
  const classes = new Set(titles.map((t) => t.cls));

  // ── 1. the source record is the size WGI published ──────────────────
  if (exp) {
    say(titles.length === exp.titles, `champions.json holds ${exp.titles} titles (got ${titles.length})`);
    say(years.length === exp.seasons, `champions.json covers ${exp.seasons} seasons (got ${years.length})`);
    say(winners.size === exp.winners, `${exp.winners} distinct champions (got ${winners.size})`);
    say(classes.size === exp.classes, `${exp.classes} classes contested (got ${classes.size})`);
    say(Math.min(...years) === exp.first && Math.max(...years) === exp.last,
      `record spans ${exp.first}–${exp.last} (got ${Math.min(...years)}–${Math.max(...years)})`);
    say(titles.every((t) => t.score != null), "every title row carries a real score");
  }

  // ── 2. corps_index: one entry per champion, no invented season ───────
  const idx = readJson(path.join(dataDir, "corps_index.json"));
  say(idx.length === winners.size,
    `corps_index lists exactly the ${winners.size} champions (got ${idx.length})`);
  const wonYears = new Map();
  const wonRows = new Map();
  titles.forEach((t) => {
    if (!wonYears.has(t.corps)) { wonYears.set(t.corps, new Set()); wonRows.set(t.corps, 0); }
    wonYears.get(t.corps).add(t.year);
    wonRows.set(t.corps, wonRows.get(t.corps) + 1);
  });
  let ghostSeason = null, badSeries = null, badSlug = null, badCount = null;
  idx.forEach((c) => {
    if (!winners.has(c.name)) ghostSeason = ghostSeason || `${c.name} is not a champion`;
    const mine = wonYears.get(c.name) || new Set();
    (c.series || []).forEach(([y, s, cls]) => {
      if (!mine.has(y)) ghostSeason = ghostSeason || `${c.name} credited with ${y}`;
      if (s != null && !real.has(key(y, cls, c.name, s)))
        badSeries = badSeries || `${c.name} ${y} ${cls} ${s}`;
    });
    if ((c.series || []).length !== mine.size)
      badSeries = badSeries || `${c.name}: ${c.series.length} series points for ${mine.size} winning seasons`;
    if (c.slug !== slugOf(c.name)) badSlug = badSlug || `${c.name} → ${c.slug}`;
    if (c.seasons !== mine.size || c.n !== wonRows.get(c.name) ||
        c.first !== Math.min(...mine) || c.last !== Math.max(...mine))
      badCount = badCount || `${c.name}`;
  });
  say(!ghostSeason, `no ensemble gains a season it did not win${ghostSeason ? ` (${ghostSeason})` : ""}`);
  say(!badSeries, `every corps_index series point is a real title${badSeries ? ` (${badSeries})` : ""}`);
  say(!badSlug, `every slug round-trips through slugOf()${badSlug ? ` (${badSlug})` : ""}`);
  say(!badCount, `first/last/seasons/n match the title list${badCount ? ` (${badCount})` : ""}`);

  // ── 3. per-ensemble logs: one row per title, no dates, place 1 ───────
  const corpsDir = path.join(dataDir, "corps");
  const files = fs.readdirSync(corpsDir).filter((f) => f.endsWith(".json"));
  say(files.length === idx.length,
    `one corps/<slug>.json per indexed ensemble (${files.length} files, ${idx.length} entries)`);
  let badPerf = null, missing = null, totalPerfs = 0;
  idx.forEach((c) => {
    const f = path.join(corpsDir, `${c.slug}.json`);
    if (!exists(f)) { missing = missing || c.slug; return; }
    const detail = readJson(f);
    if (detail.name !== c.name) badPerf = badPerf || `${c.slug} names ${detail.name}`;
    totalPerfs += detail.performances.length;
    detail.performances.forEach((p) => {
      if (!real.has(key(p.y, p.cls, c.name, p.s))) badPerf = badPerf || `${c.name} ${p.y} ${p.cls} ${p.s}`;
      if (p.p !== 1) badPerf = badPerf || `${c.name} ${p.y} place ${p.p}`;
      if (p.d !== null) badPerf = badPerf || `${c.name} ${p.y} invented date ${p.d}`;
      if (p.ev !== EVENT) badPerf = badPerf || `${c.name} ${p.y} event ${p.ev}`;
    });
    if (detail.performances.length !== wonRows.get(c.name))
      badPerf = badPerf || `${c.name}: ${detail.performances.length} rows for ${wonRows.get(c.name)} titles`;
  });
  say(!missing, `no indexed ensemble is missing its profile file${missing ? ` (${missing})` : ""}`);
  say(!badPerf, `every performance row is a real title${badPerf ? ` (${badPerf})` : ""}`);
  say(totalPerfs === titles.length,
    `the profiles hold ${titles.length} performances in total (got ${totalPerfs})`);

  // ── 4. records.json ─────────────────────────────────────────────────
  const rec = readJson(path.join(dataDir, "records.json"));
  say(Object.keys(rec).length === classes.size, `records.json covers all ${classes.size} classes`);
  let badRec = null, recRows = 0, finalsRows = 0;
  Object.entries(rec).forEach(([cls, blk]) => {
    blk.top.forEach(([y, d, corps, s, ev]) => {
      recRows++;
      if (!real.has(key(y, cls, corps, s))) badRec = badRec || `top ${cls} ${y} ${corps} ${s}`;
      if (d !== null || ev !== EVENT) badRec = badRec || `top ${cls} ${y} shape`;
    });
    // sorted best first — the view slices the head of this list
    for (let i = 1; i < blk.top.length; i++)
      if (blk.top[i - 1][3] < blk.top[i][3]) badRec = badRec || `top ${cls} out of order`;
    Object.entries(blk.finals).forEach(([y, rows]) => {
      rows.forEach(([corps, s]) => {
        finalsRows++;
        if (!real.has(key(+y, cls, corps, s))) badRec = badRec || `finals ${cls} ${y} ${corps}`;
      });
      if (rows.length !== 1)
        badRec = badRec || `finals ${cls} ${y} has ${rows.length} rows — only the champion is published`;
    });
  });
  say(!badRec, `every records.json row is a real title${badRec ? ` (${badRec})` : ""}`);
  say(recRows === titles.length && finalsRows === titles.length,
    `records.json holds all ${titles.length} titles (top ${recRows}, finals ${finalsRows})`);

  // ── 5. rankings.json ────────────────────────────────────────────────
  const rk = readJson(path.join(dataDir, "rankings.json"));
  const latest = Math.max(...years);
  say(rk.kind === "championship", 'rankings.json declares kind:"championship"');
  say(rk.season === latest, `rankings.json season is the latest championship (${latest})`);
  let badRk = null, winRows = 0;
  Object.entries(rk.winners).forEach(([cls, rows]) => {
    rows.forEach(([y, corps, s]) => {
      winRows++;
      if (!real.has(key(y, cls, corps, s))) badRk = badRk || `winners ${cls} ${y} ${corps}`;
    });
    for (let i = 1; i < rows.length; i++)
      if (rows[i - 1][0] >= rows[i][0]) badRk = badRk || `winners ${cls} not in season order`;
  });
  say(winRows === titles.length, `winners hold all ${titles.length} titles (got ${winRows})`);
  // the standings ARE the most recent championship — no more, no less
  const latestTitles = titles.filter((t) => t.year === latest);
  let standRows = 0;
  Object.entries(rk.standings).forEach(([cls, blk]) => {
    blk.rows.forEach((r) => {
      standRows++;
      if (!real.has(key(latest, cls, r.corps, r.score))) badRk = badRk || `standings ${cls} ${r.corps}`;
      if (r.date !== null || r.event !== EVENT) badRk = badRk || `standings ${cls} ${r.corps} shape`;
      if (r.home_class !== cls) badRk = badRk || `standings ${cls} ${r.corps} home_class`;
      // supporting numbers are counted off this ensemble's own titles
      const mine = titles.filter((t) => t.corps === r.corps && t.cls === cls);
      if (r.outings !== mine.length) badRk = badRk || `standings ${cls} ${r.corps} outings`;
      if (r.high !== Math.max(...mine.map((t) => t.score))) badRk = badRk || `standings ${cls} ${r.corps} high`;
      const prior = mine.filter((t) => t.year < latest).map((t) => t.year).sort((a, b) => a - b);
      const want = prior.length ? prior[prior.length - 1] : null;
      if (r.prev_title !== want) badRk = badRk || `standings ${cls} ${r.corps} prev_title`;
      (r.trend || []).forEach(([y, s]) => {
        if (!real.has(key(y, cls, r.corps, s))) badRk = badRk || `standings trend ${cls} ${r.corps} ${y}`;
      });
    });
  });
  say(standRows === latestTitles.length,
    `standings are exactly the ${latestTitles.length} titles of ${latest} (got ${standRows})`);
  say(!badRk, `every rankings.json row is a real title${badRk ? ` (${badRk})` : ""}`);

  // ── 6. the Database dataset ─────────────────────────────────────────
  const dbIndex = readJson(path.join(dataDir, "db", "index.json"));
  let dbRows = 0, badDb = null;
  dbIndex.forEach((part) => {
    const rows = readJson(path.join(dataDir, "db", `perfs_${part.decade}.json`));
    if (rows.length !== part.rows) badDb = badDb || `${part.decade}: index says ${part.rows}, file has ${rows.length}`;
    rows.forEach(([y, d, ev, corps, cls, place, s]) => {
      dbRows++;
      if (!real.has(key(y, cls, corps, s))) badDb = badDb || `db ${y} ${cls} ${corps} ${s}`;
      if (d !== null || place !== 1 || ev !== EVENT) badDb = badDb || `db ${y} ${corps} shape`;
      if (`${Math.floor(y / 10) * 10}s` !== part.decade) badDb = badDb || `db ${y} filed under ${part.decade}`;
    });
  });
  say(!badDb, `every database row is a real title${badDb ? ` (${badDb})` : ""}`);
  say(dbRows === titles.length, `the database holds all ${titles.length} titles (got ${dbRows})`);

  // ── 7. no dates anywhere: the published record carries none ─────────
  const anyDate = [
    ...idx.flatMap((c) => []),
    ...Object.values(rk.standings).flatMap((b) => b.rows.map((r) => r.date)),
  ].filter(Boolean);
  say(anyDate.length === 0, "no derived row invents a date");
}

/* ── run over the shipped trees ───────────────────────────────────────── */
const APPS = Object.keys(EXPECT);
APPS.forEach((app) => {
  const d = path.join(ROOT, "docs", app, "data");
  if (!exists(d)) { fail.push(`${app}: no data directory`); return; }
  checkApp(app, d, ok);
});

/* ── the builder itself: idempotent, and refuses a richer ingest ──────── */
function py(args, opts = {}) {
  return execFileSync("python3", [path.join(ROOT, "scripts", "build_wgi_datasets.py"), ...args],
    { cwd: ROOT, encoding: "utf8", ...opts });
}
let checkOut = "";
try {
  checkOut = py(["--check"]);
  ok(true, "builder --check is clean: re-running would change no shipped byte (idempotent)");
} catch (e) {
  ok(false, `builder --check reports drift:\n${(e.stdout || "").trim()}`);
}
ok(/SKIPPED/.test(checkOut) === false, "no app is being skipped by the LIVE-marker guard right now");

/* ── prove the guards fail on fabricated data ─────────────────────────── */
if (process.argv.includes("--corrupt")) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgi-corrupt-"));
  const src = path.join(ROOT, "docs", "wgi", "winds", "data");   // smallest tree
  fs.cpSync(src, tmp, { recursive: true });

  const PLANTS = [
    ["an ensemble credited with a season it did not win", () => {
      const p = path.join(tmp, "corps_index.json");
      const idx = readJson(p);
      idx[0].series.push([2018, 95.5, "Independent World"]);
      idx[0].seasons += 1;
      fs.writeFileSync(p, JSON.stringify(idx));
    }],
    ["a performance row with an invented score", () => {
      const p = path.join(tmp, "corps_index.json");
      const c = readJson(p)[0];
      const f = path.join(tmp, "corps", `${c.slug}.json`);
      const detail = readJson(f);
      detail.performances[0].s = 99.999;
      fs.writeFileSync(f, JSON.stringify(detail));
    }],
    ["a plausible-looking championship date", () => {
      const p = path.join(tmp, "corps_index.json");
      const c = readJson(p)[0];
      const f = path.join(tmp, "corps", `${c.slug}.json`);
      const detail = readJson(f);
      detail.performances[0].d = "2016-04-14";
      fs.writeFileSync(f, JSON.stringify(detail));
    }],
    ["an invented runner-up in the finals sheet", () => {
      const p = path.join(tmp, "records.json");
      const rec = readJson(p);
      const cls = Object.keys(rec)[0];
      const y = Object.keys(rec[cls].finals)[0];
      rec[cls].finals[y].push(["Some Other Winds", 91.2]);
      fs.writeFileSync(p, JSON.stringify(rec));
    }],
    ["a standings row for an ensemble that never won", () => {
      const p = path.join(tmp, "rankings.json");
      const rk = readJson(p);
      const cls = Object.keys(rk.standings)[0];
      rk.standings[cls].rows.push({ corps: "Phantom Winds", score: 97.5, date: null,
        event: EVENT, class: cls, home_class: cls, rank: 2, outings: 1, titles: [rk.season],
        trend: [[rk.season, 97.5]], prev_title: null, prev_score: null, delta: null,
        high: 97.5, high_year: rk.season, high_event: EVENT, high_date: null });
      fs.writeFileSync(p, JSON.stringify(rk));
    }],
  ];

  console.log("\n── corruption drill (scratch copy of docs/wgi/winds/data) ──");
  // the clean copy is restored before each plant, so the drills stay independent
  PLANTS.forEach(([what, plant]) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true });
    const clean = [];
    checkApp("wgi/winds", tmp, (cond, msg) => { if (!cond) clean.push(msg); });
    if (clean.length) { ok(false, `drill setup: the scratch copy is already failing (${clean[0]})`); return; }
    plant();
    const caught = [];
    checkApp("wgi/winds", tmp, (cond, msg) => { if (!cond) caught.push(msg); });
    console.log(`  ${caught.length ? "RED  " : "GREEN"} ← ${what}` +
      (caught.length ? `\n         ${caught[0]}` : ""));
    ok(caught.length > 0, `guard catches: ${what}`);
  });

  // the LIVE-marker contract: the builder must stand down the moment a real
  // per-show ingest lands, rather than overwrite it with a thinner derivation
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(src, tmp, { recursive: true });
  const reason = (dir) => execFileSync("python3", ["-c", `
import sys, pathlib; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts"))})
import build_wgi_datasets as b
print(b.refusal_reason(pathlib.Path(${JSON.stringify(dir)})) or "")
`], { encoding: "utf8" }).trim();
  ok(reason(tmp) === "", "builder accepts a champion-record-only tree");
  fs.writeFileSync(path.join(tmp, "seasons", "2027.json"), JSON.stringify([{
    name: "WGI World Championships", date: "2027-04-15",
    classes: [{ class: "Independent World", results: [{ corps: "Rhythm X", place: 1, score: 97.1 }] }],
  }]));
  ok(/richer real ingest has landed/.test(reason(tmp)),
    "builder refuses a tree whose seasons/ already carry real scored results");
  fs.rmSync(path.join(tmp, "CHAMPS_LIVE"));
  ok(/CHAMPS_LIVE/.test(reason(tmp)), "builder refuses a tree with no CHAMPS_LIVE marker");
  fs.rmSync(tmp, { recursive: true, force: true });

  // and the builder's own in-process assertion
  try {
    execFileSync("python3", ["-c", `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts"))})
import build_wgi_datasets as b
titles = [{"year": 2026, "cls": "Independent World", "corps": "Real Winds", "score": 95.0}]
idx, logs = b.build_corps(titles)
logs["Real Winds"][0]["s"] = 99.9          # a score nobody scored
b.assert_traceable("test", titles, idx, logs, b.build_records(titles),
                   b.build_rankings(titles, []), b.build_db(titles)[1])
`], { encoding: "utf8", stdio: "pipe" });
    ok(false, "builder's assert_traceable() rejects a fabricated score");
  } catch (e) {
    ok(/does not trace to a real champion row/.test(String(e.stderr || "")),
      "builder's assert_traceable() rejects a fabricated score");
  }
}

/* ── report ──────────────────────────────────────────────────────────── */
console.log(`\n${pass.length} passed`);
pass.forEach((m) => console.log(`  ok   ${m}`));
if (fail.length) {
  console.log(`\n${fail.length} FAILED`);
  fail.forEach((m) => console.log(`  FAIL ${m}`));
  process.exit(1);
}
console.log("\nall WGI dataset guards green");
