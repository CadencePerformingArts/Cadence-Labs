// Season utilities: cross-class stitching, prediction grading, quiet-season
// detection — the logic behind several hard-won bug fixes.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./lib-loader");

const { CadSeasonUtils } = loadLib("season-utils.js");
const { stitchSeasonHistory, scorePred, daysSinceLastScore, rankingsFromEvents } = CadSeasonUtils;

// ---- stitching --------------------------------------------------------------

function standingsFixture() {
  // River City ran Open Class all season, then World Class prelims once —
  // the exact shape that used to produce "—" deltas and one-point trends.
  return {
    "World Class": { rows: [
      { corps: "River City", class: "World Class", score: 80.0, date: "2026-08-07",
        event: "Prelims", trend: [["2026-08-07", 80.0]], high: 80.0, high_event: "Prelims", high_date: "2026-08-07", delta: null, rank: 22 },
      { corps: "Blue Alpha", class: "World Class", score: 95.0, date: "2026-08-07",
        event: "Prelims", trend: [["2026-08-01", 93.0], ["2026-08-07", 95.0]], high: 95.0, delta: 2.0, rank: 1 },
    ] },
    "Open Class": { rows: [
      { corps: "River City", class: "Open Class", score: 79.0, date: "2026-08-05",
        event: "Open Finals", trend: [["2026-07-20", 74.0], ["2026-08-05", 79.0]], high: 79.0, high_event: "Open Finals", high_date: "2026-08-05", delta: 5.0, rank: 2 },
    ] },
  };
}

test("stitching gives a cross-class corps its real season trend, delta, and high", () => {
  const st = standingsFixture();
  const out = stitchSeasonHistory(st, st["World Class"].rows);
  const rc = out.find(r => r.corps === "River City");
  assert.equal(rc.trend.length, 3);                       // 7/20, 8/5, 8/7
  assert.equal(rc.prev_score, 79.0);                      // Open Finals
  assert.equal(rc.delta, +(80.0 - 79.0).toFixed(3));      // vs-prev now real
  assert.equal(rc.high, 80.0);                            // prelims run beat the Open high
  // the row itself still describes the class being shown
  assert.equal(rc.score, 80.0);
  assert.equal(rc.event, "Prelims");
});

test("a single-class corps' row passes through unchanged", () => {
  const st = standingsFixture();
  const out = stitchSeasonHistory(st, st["World Class"].rows);
  const ba = out.find(r => r.corps === "Blue Alpha");
  assert.deepEqual(ba, st["World Class"].rows.find(r => r.corps === "Blue Alpha"));
});

test("one point per date — the shown row's own show wins its date", () => {
  const st = {
    A: { rows: [{ corps: "X", score: 70, date: "2026-07-01", trend: [["2026-07-01", 70]] }] },
    B: { rows: [{ corps: "X", score: 72, date: "2026-07-01", trend: [["2026-07-01", 72], ["2026-07-03", 74]] }] },
  };
  const out = stitchSeasonHistory(st, st.A.rows);
  const x = out[0];
  assert.equal(x.trend.length, 2);
  assert.equal(x.trend[0][1], 70);   // the row being shown wins 07-01, not the higher 72
});

test("stitching never duplicates a corps or invents rows", () => {
  const st = standingsFixture();
  const out = stitchSeasonHistory(st, st["World Class"].rows);
  assert.equal(out.length, st["World Class"].rows.length);
  assert.equal(new Set(out.map(r => r.corps)).size, out.length);
});

// ---- prediction grading -----------------------------------------------------

test("grading: exact = 3, off-by-one = 1, further = 0", () => {
  const actual = ["A", "B", "C", "D"];
  assert.deepEqual({ ...scorePred(["A", "B", "C", "D"], actual) }, { pts: 12, max: 12, exact: 4, n: 4, pct: 100 });
  const swapped = scorePred(["B", "A", "C", "D"], actual);
  assert.equal(swapped.pts, 1 + 1 + 3 + 3);
  assert.equal(swapped.exact, 2);
  const reversed = scorePred(["D", "C", "B", "A"], actual);
  assert.equal(reversed.exact, 0);
  assert.equal(reversed.pts, 0 + 1 + 1 + 0); // C and B are each off by one
});

test("grading: scratched corps don't count; empty pick grades 0/0", () => {
  const r = scorePred(["A", "Ghost Corps", "B"], ["A", "B"]);
  assert.equal(r.n, 2);              // Ghost Corps ignored
  assert.equal(r.max, 6);
  // A exact (3); B picked 3rd but finished 2nd → my index 2 vs actual 1 = off by one (1)
  assert.equal(r.pts, 4);
  assert.deepEqual({ ...scorePred([], ["A", "B"]) }, { pts: 0, max: 0, exact: 0, n: 0, pct: 0 });
});

// ---- quiet-season detection -------------------------------------------------

const NOON = (iso) => Date.UTC(...iso.split("-").map(Number).map((v, i) => i === 1 ? v - 1 : v), 12);

test("daysSinceLastScore counts from the newest score across every class", () => {
  const rk = { standings: {
    "World Class": { rows: [{ corps: "A", date: "2026-08-01" }] },
    "Open Class": { rows: [{ corps: "B", date: "2026-08-08" }] },
  } };
  assert.equal(daysSinceLastScore(rk, NOON("2026-08-08")), 0);
  assert.equal(daysSinceLastScore(rk, NOON("2026-08-15")), 7);
  assert.equal(daysSinceLastScore(rk, NOON("2026-08-16")), 8);   // > 7 → off-season framing
});

test("no scores at all reads as forever-quiet", () => {
  assert.equal(daysSinceLastScore({ standings: {} }, Date.UTC(2026, 0, 1)), Infinity);
  assert.equal(daysSinceLastScore({}, Date.UTC(2026, 0, 1)), Infinity);
});

// ---- historical season boards (the Scoreboard's year picker) ---------------

const ev = (date, name, cls, results) => ({ date, name, classes: [{ class: cls, results }] });
function twoShowSeason() {
  return [
    ev("2019-07-01", "Show A", "World Class", [
      { place: 1, corps: "Alpha", score: 80 }, { place: 2, corps: "Beta", score: 79 }, { place: 3, corps: "Gamma", score: 70 }]),
    ev("2019-08-10", "Finals", "World Class", [
      { place: 1, corps: "Beta", score: 95 }, { place: 2, corps: "Alpha", score: 94.5 }, { place: 3, corps: "Gamma", score: 71 }]),
  ];
}

test("a past season builds ranks, deltas, highs and trends from its events", () => {
  const rk = rankingsFromEvents(twoShowSeason(), { season: 2019 });
  assert.equal(rk.season, 2019);
  assert.equal(rk.archived, true);
  const rows = rk.standings["World Class"].rows;
  assert.deepEqual(rows.map(r => r.corps), ["Beta", "Alpha", "Gamma"]);   // ranked by latest score
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3]);
  const beta = rows[0];
  assert.equal(beta.score, 95);
  assert.equal(beta.event, "Finals");
  assert.equal(beta.prev_score, 79);
  assert.equal(beta.delta, 16);
  assert.equal(beta.high, 95);
  assert.equal(beta.high_event, "Finals");
  assert.equal(beta.outings, 2);
  assert.deepEqual(beta.trend.map(t => t[1]), [79, 95]);
});

test("movers rank by absolute change; battles by smallest gap", () => {
  const rk = rankingsFromEvents(twoShowSeason(), { season: 2019 });
  const b = rk.standings["World Class"];
  assert.equal(b.movers[0].corps, "Beta");        // +16 beats Alpha's +14.5
  assert.equal(b.battles[0].gap, 0.5);            // Beta 95 vs Alpha 94.5
  assert.equal(b.battles[0].a, "Beta");
  assert.ok(b.movers.length <= 3 && b.battles.length <= 3);
});

test("a corps with one show has no delta and a single-point trend", () => {
  const evs = twoShowSeason();
  evs[1].classes[0].results.push({ place: 4, corps: "Newcomer", score: 60 });
  const rows = rankingsFromEvents(evs, { season: 2019 }).standings["World Class"].rows;
  const nc = rows.find(r => r.corps === "Newcomer");
  assert.equal(nc.delta, null);
  assert.equal(nc.prev_score, null);
  assert.equal(nc.trend.length, 1);
});

test("null and zero scores are skipped, undated events ignored", () => {
  const evs = twoShowSeason();
  evs.push(ev(null, "Undated", "World Class", [{ corps: "Ghost", score: 99 }]));
  evs[0].classes[0].results.push({ corps: "Scratched", score: null }, { corps: "Zeroed", score: 0 });
  const rows = rankingsFromEvents(evs, { season: 2019 }).standings["World Class"].rows;
  const names = rows.map(r => r.corps);
  assert.ok(!names.includes("Ghost"), "undated event must not contribute");
  assert.ok(!names.includes("Scratched"), "null score must not create a row");
  assert.ok(!names.includes("Zeroed"), "zero score must not create a row");
});

test("trend keeps only the last 10 shows", () => {
  const evs = [];
  for (let i = 1; i <= 14; i++) {
    const d = `2019-07-${String(i).padStart(2, "0")}`;
    evs.push(ev(d, "Show " + i, "World Class", [
      { corps: "Alpha", score: 70 + i }, { corps: "Beta", score: 69 + i }, { corps: "Gamma", score: 68 + i }]));
  }
  const alpha = rankingsFromEvents(evs, { season: 2019 }).standings["World Class"].rows[0];
  assert.equal(alpha.outings, 14);
  assert.equal(alpha.trend.length, 10);
  assert.equal(alpha.trend[9][1], 84);      // most recent kept
  assert.equal(alpha.trend[0][1], 75);      // oldest four dropped
});

test("archive residue classes are not offered as boards; real divisions are", () => {
  const evs = twoShowSeason();
  // a one-off junk label with too few corps and only one event
  evs[0].classes.push({ class: "Iiii", results: [{ corps: "Odd One", score: 50 }] });
  // a real division: enough corps across both shows
  [0, 1].forEach(i => evs[i].classes.push({ class: "Class A", results: [
    { corps: "A1", score: 60 }, { corps: "A2", score: 59 }, { corps: "A3", score: 58 }] }));
  const rk = rankingsFromEvents(evs, { season: 2019 });
  assert.ok(!rk.listClasses.includes("Iiii"), "residue class must not be offered");
  assert.ok(rk.listClasses.includes("Class A"), "a real multi-event division must be offered");
  assert.ok(rk.listClasses.includes("World Class"));
});

test("a class competing at only one show is not a standings board", () => {
  const evs = twoShowSeason();
  evs[0].classes.push({ class: "Exhibition", results: [
    { corps: "E1", score: 60 }, { corps: "E2", score: 59 }, { corps: "E3", score: 58 }, { corps: "E4", score: 57 }] });
  assert.ok(!rankingsFromEvents(evs, { season: 2019 }).listClasses.includes("Exhibition"),
    "4 corps but a single event → not offered as a board");
});

// Regression: filtered classes must still reach stitchSeasonHistory, or a corps
// that also ran a filtered division gets a wrong season high / average / spark.
test("filtered-out classes stay in standings so season stitching stays honest", () => {
  const evs = twoShowSeason();
  // Alpha also won a one-off exhibition with their best score of the year
  evs[0].classes.push({ class: "Iiii", results: [{ corps: "Alpha", score: 99 }] });
  const rk = rankingsFromEvents(evs, { season: 2019 });
  assert.ok(!rk.listClasses.includes("Iiii"), "still not offered as a board");
  assert.ok("Iiii" in rk.standings, "but still present for stitching");
  const stitched = stitchSeasonHistory(rk.standings, rk.standings["World Class"].rows);
  const alpha = stitched.find(r => r.corps === "Alpha");
  assert.equal(alpha.high, 99, "season high must account for every class the corps competed in");
  assert.ok(alpha.trend.some(t => t[1] === 99), "sparkline must include it too");
});

// Championship weekends run prelims and finals, sometimes on the same date.
test("same-day rounds order prelims → semis → finals, so finals is the last score", () => {
  const evs = [
    ev("2019-07-01", "Regional", "All-Age", [
      { corps: "Sun", score: 80 }, { corps: "Cabs", score: 79 }, { corps: "Bush", score: 78 }]),
    // deliberately listed finals-before-prelims, the order the archive uses
    ev("2019-08-31", "DCA Championships Finals", "All-Age", [
      { corps: "Sun", score: 94.15 }, { corps: "Cabs", score: 93 }, { corps: "Bush", score: 92 }]),
    ev("2019-08-31", "DCA Championships Prelims", "All-Age", [
      { corps: "Sun", score: 93.35 }, { corps: "Cabs", score: 92 }, { corps: "Bush", score: 91 }]),
  ];
  const top = rankingsFromEvents(evs, { season: 2019 }).standings["All-Age"].rows[0];
  assert.equal(top.corps, "Sun");
  assert.equal(top.score, 94.15, "the finals score is the season's last score");
  assert.equal(top.event, "DCA Championships Finals");
  assert.equal(top.prev_score, 93.35, "prelims is the previous outing");
  assert.ok(top.delta > 0, `delta should not run backwards in time (got ${top.delta})`);
});

test("empty and malformed input never throws", () => {
  assert.deepEqual(rankingsFromEvents([], { season: 2019 }).standings, {});
  assert.deepEqual(rankingsFromEvents(null, { season: 2019 }).standings, {});
  assert.deepEqual(rankingsFromEvents([{}, { date: "2019-01-01" }, { date: "x", classes: null }], {}).standings, {});
});

// The browser mirror must keep agreeing with the Python builder: rebuild the
// CURRENT season from its events file and compare against the rankings.json
// the pipeline itself generated. If either implementation drifts, this fails.
test("mirrors the Python builder exactly for the live season", () => {
  const fs = require("node:fs"), path = require("node:path");
  const root = path.join(__dirname, "..", "..");
  const real = JSON.parse(fs.readFileSync(path.join(root, "docs/data/rankings.json"), "utf8"));
  const evs = JSON.parse(fs.readFileSync(path.join(root, `docs/data/seasons/${real.season}.json`), "utf8"));
  const mine = rankingsFromEvents(evs, { season: real.season, minCorps: 0, minEvents: 0 });
  assert.deepEqual(Object.keys(mine.standings).sort(), Object.keys(real.standings).sort());
  for (const cls of Object.keys(real.standings)) {
    const a = mine.standings[cls], b = real.standings[cls];
    assert.equal(a.rows.length, b.rows.length, `${cls} row count`);
    a.rows.forEach((row, i) => {
      for (const k of ["corps", "score", "date", "event", "high", "high_event", "high_date",
        "prev_score", "delta", "outings", "rank"])
        assert.deepEqual(row[k], b.rows[i][k], `${cls}.rows[${i}].${k}`);
      assert.deepEqual([...row.trend], [...b.rows[i].trend], `${cls}.rows[${i}].trend`);
    });
    assert.deepEqual(a.movers.map(m => m.corps), b.movers.map(m => m.corps), `${cls} movers`);
    assert.deepEqual(a.battles.map(x => ({ ...x })), b.battles.map(x => ({ ...x })), `${cls} battles`);
  }
});
