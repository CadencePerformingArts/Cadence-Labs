// LIVE decision rules — every historical hot spot, on a controlled clock.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./lib-loader");

const { CadLiveCore } = loadLib("live-core.js");
const { LIVE_PAD, slotMs, slotLiveAt, compute } = CadLiveCore;

const DAY = "2026-07-15";
// 7:30 PM ET on the show date, in UTC ms (EDT = UTC-4)
const SLOT_1930 = Date.UTC(2026, 6, 15, 23, 30);

function show(over = {}) {
  return {
    name: "Test Show", date: DAY,
    lineup: ["Alpha Corps", "Beta Corps", "Gamma Corps"],
    schedule: [
      ["6:45 PM", "Gates open"],
      ["7:30 PM", "Alpha Corps"],
      ["7:47 PM", "Beta Corps"],
      ["8:04 PM", "Gamma Corps"],
      ["8:30 PM", "Scores announced"],
    ],
    ...over,
  };
}
function season(scored) {
  // scored: array of corps with posted scores today
  return [{
    name: "Test Show", date: DAY,
    classes: [{ class: "World Class", results: scored.map((c, i) => ({ place: i + 1, corps: c, score: 90 - i })) }],
  }];
}

test("slotMs parses ET clock times to UTC", () => {
  assert.equal(slotMs(DAY, "7:30 PM"), SLOT_1930);
  assert.equal(slotMs(DAY, "7:30 p.m."), SLOT_1930);
  assert.equal(slotMs(DAY, "12:05 AM"), Date.UTC(2026, 6, 15, 4, 5));
  assert.equal(slotMs(DAY, "TBA"), null);
  assert.equal(slotMs("", "7:30 PM"), null);
});

test("a corps is live only inside its ±15-minute window", () => {
  assert.equal(slotLiveAt(DAY, "7:30 PM", SLOT_1930 - LIVE_PAD - 1), false);
  assert.equal(slotLiveAt(DAY, "7:30 PM", SLOT_1930 - LIVE_PAD), true);
  assert.equal(slotLiveAt(DAY, "7:30 PM", SLOT_1930), true);
  assert.equal(slotLiveAt(DAY, "7:30 PM", SLOT_1930 + LIVE_PAD), true);
  assert.equal(slotLiveAt(DAY, "7:30 PM", SLOT_1930 + LIVE_PAD + 1), false);
});

test("during a slot the corps and the show are live; logistics rows never join corpsLive", () => {
  const r = compute([show()], season([]), DAY, SLOT_1930);
  assert.equal(r.corpsLive.has("Alpha Corps"), true);
  assert.equal(r.corpsLive.has("Gates open"), false);
  assert.equal(r.corpsLive.has("Scores announced"), false);
  assert.equal(r.showLive.has("Test Show"), true);
  assert.equal(r.complete.size, 0);
});

test("a corps whose score already posted is no longer live, others still are", () => {
  const r = compute([show()], season(["Alpha Corps"]), DAY, SLOT_1930);
  assert.equal(r.corpsLive.has("Alpha Corps"), false);
  assert.equal(r.scored.has("Alpha Corps"), true);
  // Beta's 7:47 slot overlaps 7:30+15 → still inside its window at 7:47-15
  const atBeta = slotMs(DAY, "7:47 PM");
  const r2 = compute([show()], season(["Alpha Corps"]), DAY, atBeta);
  assert.equal(r2.corpsLive.has("Beta Corps"), true);
  assert.equal(r2.showLive.has("Test Show"), true); // partial scores: show stays live
});

test("the whole show goes dark the instant every real corps has a score", () => {
  const r = compute([show()], season(["Alpha Corps", "Beta Corps", "Gamma Corps"]), DAY, SLOT_1930);
  assert.equal(r.complete.has("Test Show"), true);
  assert.equal(r.showLive.has("Test Show"), false); // even mid-window
  assert.equal(r.corpsLive.size, 0);
});

test("show window spans the full schedule, logistics included, and expires after last slot + pad", () => {
  const gatesOpen = slotMs(DAY, "6:45 PM");
  const scoresAnn = slotMs(DAY, "8:30 PM");
  // before gates-open window: nothing live
  assert.equal(compute([show()], season([]), DAY, gatesOpen - LIVE_PAD - 1).showLive.size, 0);
  // logistics slots hold the show window even with no corps on the field
  assert.equal(compute([show()], season([]), DAY, gatesOpen).showLive.has("Test Show"), true);
  assert.equal(compute([show()], season([]), DAY, scoresAnn + LIVE_PAD).showLive.has("Test Show"), true);
  // scores never arrive: the show simply expires after its last slot + pad
  assert.equal(compute([show()], season([]), DAY, scoresAnn + LIVE_PAD + 1).showLive.size, 0);
});

test("events on other days and malformed schedules are ignored", () => {
  const r = compute([show({ date: "2026-07-16" })], season([]), DAY, SLOT_1930);
  assert.equal(r.showLive.size, 0);
  const r2 = compute([show({ schedule: null })], season([]), DAY, SLOT_1930);
  assert.equal(r2.showLive.size, 0);
  const r3 = compute([show({ schedule: [["TBA", "Alpha Corps"]] })], season([]), DAY, SLOT_1930);
  assert.equal(r3.corpsLive.size, 0);
});

test("two shows on one day complete independently", () => {
  const early = show({ name: "Matinee", schedule: [["1:00 PM", "Alpha Corps"]], lineup: ["Alpha Corps"] });
  const evening = show();
  const seasonData = [
    { name: "Matinee", date: DAY, classes: [{ class: "World Class", results: [{ place: 1, corps: "Alpha Corps", score: 88 }] }] },
  ];
  const r = compute([early, evening], seasonData, DAY, SLOT_1930);
  assert.equal(r.complete.has("Matinee"), true);
  assert.equal(r.showLive.has("Test Show"), true);
});
