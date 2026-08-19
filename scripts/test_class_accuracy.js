#!/usr/bin/env node
/* Class accuracy: a corps belongs to exactly one class.
 *
 * The bug this guards: rk.standings is keyed by the board a corps competed
 * ON, not the class it belongs TO. Open Class corps run World Class prelims
 * at Championships and so earn a World Class row — correctly, they competed
 * there. But the first-run "Who do you follow?" picker read those buckets
 * straight, which listed eleven Open Class corps under WORLD CLASS, with
 * River City Rhythm appearing in that list AND again under OPEN CLASS.
 *
 * build_data.py now resolves each corps' home class from where it actually
 * competes most (River City Rhythm: Open 10, World 2), breaking ties toward
 * the more specific class because a World Class corps never guests in
 * Open/All-Age/International while the reverse is routine.
 *
 *   node scripts/test_class_accuracy.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass : fail).push(msg);

const CLASS_ORDER = ["World Class", "Open Class", "All-Age", "International"];
const rk = readJson("docs/data/rankings.json");
const standings = rk.standings || {};

// ── every row carries a home class ────────────────────────────────────
const allRows = Object.values(standings).flatMap((b) => b.rows || []);
ok(allRows.length > 0, "rankings.json has standings rows to check");
const missing = allRows.filter((r) => !r.home_class);
ok(missing.length === 0,
  missing.length
    ? `every standings row carries home_class (${missing.length} without: ${missing.slice(0, 3).map((r) => r.corps).join(", ")})`
    : "every standings row carries home_class");

// a corps' home class is the SAME wherever it appears
const homeByCorps = new Map();
let inconsistent = 0;
allRows.forEach((r) => {
  if (!r.home_class) return;
  if (homeByCorps.has(r.corps) && homeByCorps.get(r.corps) !== r.home_class) inconsistent++;
  homeByCorps.set(r.corps, r.home_class);
});
ok(inconsistent === 0,
  "a corps' home class is identical on every board it appears on");

// ── the picker's grouping: one chip per corps, filed by home class ────
// Pulled out of docs/app.js and EXECUTED, not reimplemented here: a copy of
// the logic would keep passing after someone changed the real thing.
const sortClasses = (names) => names.slice().sort((a, b) => {
  const ia = CLASS_ORDER.indexOf(a), ib = CLASS_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});
const appSrc = read("docs/app.js");
const GROUPING = /\n {6}const seen = new Set\(\);[\s\S]*?\.filter\(g => g\.rows\.length\);/;
const block = appSrc.match(GROUPING);
if (!block) {
  console.log("FAIL 1\n  FAIL could not find the onboarding grouping block in docs/app.js");
  process.exit(1);
}
const groups = new Function("rk", "sortClasses",
  block[0] + "\nreturn groups;")({ standings }, sortClasses);

const byClass = new Map(groups.map((g) => [g.cls, g.rows.map((r) => r.corps)]));
const flat = [...byClass.values()].flat();
const dupes = flat.filter((c, i) => flat.indexOf(c) !== i);
ok(dupes.length === 0,
  dupes.length ? `no corps is offered twice in the picker (dupes: ${[...new Set(dupes)].join(", ")})`
               : "no corps is offered twice in the picker");

// ── the specific regression, by name ─────────────────────────────────
// These competed at World Class shows in 2026 but are Open Class corps.
const NOT_WORLD = ["River City Rhythm", "Blue Devils B", "Colt Cadets", "Les Stentors",
                   "7th Regiment", "Raiders", "Columbians", "Memphis Blues",
                   "The Battalion", "Gold", "Eclipse", "Heat Wave"];
const world = new Set(byClass.get("World Class") || []);
const leaked = NOT_WORLD.filter((c) => world.has(c) && homeByCorps.has(c));
ok(leaked.length === 0,
  leaked.length ? `no Open Class corps is filed as World Class (leaked: ${leaked.join(", ")})`
                : "no Open Class corps is filed as World Class");

// …and the corps that genuinely DID move up are still World Class, so the
// fix cannot be a blanket "anything that also appears in Open Class is Open".
const REALLY_WORLD = ["Spartans", "Seattle Cascades", "Genesis", "Bluecoats"];
const demoted = REALLY_WORLD.filter((c) => homeByCorps.has(c) && !world.has(c));
ok(demoted.length === 0,
  demoted.length ? `corps that really are World Class stay World Class (wrongly moved: ${demoted.join(", ")})`
                 : "corps that really are World Class stay World Class");

// ── the picker source still reads home_class ─────────────────────────
const app = read("docs/app.js");
const overlay = app.slice(app.indexOf('first-run onboarding: "Who do you follow?"'));
ok(/r\.home_class \|\| cls/.test(overlay.slice(0, 8000)),
  "the onboarding picker files corps by home_class, not by the board bucket");

// ── build_data.py derives it from real result counts ─────────────────
const build = read("scraper/build_data.py");
ok(/def home_class\(/.test(build) && /class_counts\.setdefault/.test(build),
  "build_data.py derives home class from how often a corps competes in each class");
ok(/specific = \[c for c in tied if c != "World Class"\]/.test(build),
  "…and breaks ties toward the more specific class");

console.log(`PASS ${pass.length}`);
pass.forEach((m) => console.log("  ok   " + m));
if (fail.length) {
  console.log(`FAIL ${fail.length}`);
  fail.forEach((m) => console.log("  FAIL " + m));
  process.exit(1);
}
