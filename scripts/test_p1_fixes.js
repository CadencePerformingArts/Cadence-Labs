#!/usr/bin/env node
/* Regression guards for the P1 functional-bug fixes.
 *
 * These assert source-level invariants that are cheap to check and would
 * otherwise silently regress (an emoji sweep re-escaping an icon, a copy of
 * the old repo name creeping back, a dead toggle returning). Behavioural
 * fixes (timezone conversion, RLS) are covered by their own suites; this
 * catches the mechanical ones.
 *
 *   node scripts/test_p1_fixes.js
 *
 * REBASE NOTE (docs/ rebased onto DCI-Tracker's design core, 63d46106b).
 * The swap replaced docs/app.js, app.css and index.html wholesale, so several
 * guards below had to be re-triaged. Three categories, and the distinction
 * matters when you read a failure:
 *
 *   - MOVED: the fix survived, its code just lives somewhere new. Those
 *     guards are re-anchored at the new home (docs/lib/*.js, mostly) and
 *     pass again. They are NOT weakened — reverting the fix in the new
 *     location still turns them red.
 *   - REVERTED: the rebase brought back the bug. The upstream file never
 *     carried the Cadence fix, so the swap undid it. These guards stay RED
 *     on purpose. They are real, they are not test rot, and the fix belongs
 *     in a file this suite does not own — each one prints where.
 *   - RETIRED: the guard protected a Cadence-only feature the rebase
 *     deliberately removed. Deleted, and named in the comment where it sat.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
// `fix` is where the repair goes when a guard is red — printed with the
// failure so a REVERTED guard reads as a work item, not as a broken test.
const ok = (cond, msg, fix) => (cond ? pass.push(msg) : fail.push({ msg, fix }));

// #8 escaped-SVG icons: no site should esc() an icon string (renders markup)
["docs/ensemble/ops.js", "docs/ensemble/event.html", "docs/ensemble/calendar.html"].forEach((f) => {
  ok(!/esc\((?:k|c)\.icon\b/.test(read(f)), `#8 ${f}: no esc() around an icon string`);
});

// #9 music tab highlights Music, not Files
ok(/CadOrg\.start\(\{\s*nav:\s*"music"/.test(read("docs/ensemble/music.html")),
  "#9 music.html boots with nav:'music'");

// #12 signups gated on the base-plan 'signups' feature, not Pro-only key
ok(!/volunteer_management/.test(read("docs/ensemble/event.html")),
  "#12 event.html no longer gates signups on volunteer_management");

// #13 drill.manage is in the role editor's permission vocabulary
ok(/drill\.manage/.test(read("docs/ensemble/people.js")),
  "#13 people.js PERM_GROUPS includes drill.manage");

// #16 REVERTED. The prediction-reminder toggle is back in Settings, and it is
// still dead: `cad-notify-preds` is written on click and read only to paint
// the toggle's own state. Nothing consumes it to decide whether to send a
// reminder — the only other mention repo-wide is account.js's cross-device
// sync allowlist, which syncs the key without anyone acting on it. A control
// that claims to silence a notification and does nothing is the bug.
ok(!/cad-notify-preds/.test(read("docs/app.js")),
  "#16 app.js no longer references the dead cad-notify-preds toggle",
  "docs/app.js — drop the predsToggle row (~line 4037) + its read/write (~3954, ~4177), or wire it to a real send path");

// #17 MOVED, then REVERTED. The LIVE-window slot math moved out of app.js
// into docs/lib/live-core.js — but the upstream copy computes the slot as
// `Date.UTC(y, m, d, h + 4, min)`, a hardcoded EDT offset. That is exactly
// what the P1 fix removed: it makes the ±15-min LIVE pill 3 hours early for
// a west-coast venue and 1 hour off outside EDT. app.js still converts the
// DISPLAYED time correctly via tzOffsetMin(tz)/venueZone, so the pill and the
// printed start time now disagree — the disagreement the fix existed to end.
{
  const live = read("docs/lib/live-core.js");
  ok(/function slotMs\([^)]*\btz\b/.test(live) && !/h \+ 4\b/.test(live),
    "#17 live-core slotMs converts via the venue timezone, not a hardcoded UTC-4",
    "docs/lib/live-core.js — take a tz argument and convert with tzOffsetMin, as docs/app.js localizeVenueTime does; app.js LIVE must pass venueZone(ev.location). NOTE: tests/unit/live-core.test.js pins the hardcoded EDT result and must move with it");
}
// #17 REVERTED. refreshShowFlag decides "is a show on tonight" — it drives the
// 30s fast-poll. Upstream derives the day with toISOString(), i.e. UTC, so
// between 8pm and midnight Eastern the date has already rolled over and
// tonight's show drops off the fast-poll list while it is still running.
{
  const body = /async function refreshShowFlag\(\)[\s\S]*?\n    \}/.exec(read("docs/app.js"));
  ok(!!body && /timeZone: "America\/New_York"/.test(body[0]) && !/toISOString/.test(body[0]),
    "#17 app.js show-day flag computes the day in Eastern, not UTC",
    'docs/app.js refreshShowFlag — day = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms))');
}

// #18 MOVED. The combined-standings merge left app.js for
// docs/lib/season-utils.js stitchSeasonHistory(), which does the same job
// better: prev_score AND delta are both read off the merged trend, so the
// Biggest Move card's "prev → score" line can't disagree with its own delta.
// Re-anchored on that derivation rather than on the old object literal.
{
  const su = read("docs/lib/season-utils.js");
  const stitch = /function stitchSeasonHistory\([\s\S]*?\n  \}/.exec(su);
  ok(!!stitch && /var prev = i > 0 \? trend\[i - 1\]\[1\] : null;/.test(stitch[0])
    && /prev_score: prev != null \? prev/.test(stitch[0])
    && /delta: prev != null \? \+\(r\.score - prev\)/.test(stitch[0]),
    "#18 merged rows carry prev_score AND delta from the merged trend (lib/season-utils.js)");
}

// #19 REVERTED. The rebase carried upstream's identity in with its design.
// Two flavours, both shipping: the suggestions box files issues on
// LukeBesel/DCI-Tracker, and the show-day fast path reads scores from that
// repo's raw.githubusercontent — so Cadence's live scoreboard is fed by
// someone else's data branch. index.html's canonical/og URLs and
// lib/config.js's BASE_URL point there too, which is what share cards and
// search engines quote back.
ok(/SUGGEST_REPO = "CadencePerformingArts\/Cadence-Labs"/.test(read("docs/app.js")),
  "#19 app.js suggestions repo is the current one",
  'docs/app.js ~3920 — SUGGEST_REPO = "CadencePerformingArts/Cadence-Labs"');
{
  // the upstream identity in its two shipped forms: the repo slug and the
  // Pages host. A prose mention ("...until the DCI-Tracker rebase") has
  // neither, so comments about the lineage don't trip this.
  const UPSTREAM = /lukebesel(?:\.github\.io)?\/DCI-Tracker/i;
  const shipped = ["docs/app.js", "docs/wrapped.js", "docs/index.html", "docs/lib/config.js"];
  const offenders = shipped.filter((f) => UPSTREAM.test(read(f)));
  ok(offenders.length === 0,
    `#19 no shipped file advertises the upstream repo (${offenders.length} offenders${offenders.length ? ": " + offenders.join(", ") : ""})`,
    "point these at CadencePerformingArts/Cadence-Labs. docs/family/* is generated — re-run scripts/build_family_engine.py after fixing docs/app.js");
}

// #20 RETIRED. Was: `modes.js here() recognises unlisted circuit apps`,
// asserting a UNLISTED = ["boa","usbands","uil","wgasc","tcgc","ffcc"] list in
// the registry-less fallback. All six circuits were retired with the rebase and
// their docs/ directories deleted, so the loop could never match again; modes.js
// dropped the dead array. Nothing left to guard.

// #22 purge tool clears the real key and writes the right index shape
{
  const s = read("scripts/purge_fabricated.py");
  ok(/cur\["performances"\] = \[\]/.test(s), "#22 purge clears 'performances', not 'perfs'");
  ok(/dump\(d \/ "db" \/ "index\.json", \[\]\)/.test(s), "#22 purge writes db/index.json as a list");
  ok(/DRY = /.test(s) && /--dry-run/.test(s), "#22 purge has a dry-run mode");
}

// #26 REVERTED. Every page in docs/ declares `color-scheme: light dark` —
// except index.html, which came over from upstream pinned to light. The app
// itself ships a full dark theme (index.html's own boot script reads
// prefers-color-scheme), so the meta contradicts the page: it tells the
// browser to render form controls, scrollbars and the address bar light-only
// for a fan whose phone is in dark mode.
//
// Walks the tree in Node rather than shelling out to grep: docs/ensemble/
// music.html contains a raw NUL byte, which makes grep treat it as binary and
// skip its contents, so a grep-based sweep can quietly miss a page.
{
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + "/" + e.name;
      if (e.isDirectory()) { if (e.name !== "data") walk(rel); continue; }
      if (!e.name.endsWith(".html")) continue;
      if (/<meta\s+name="color-scheme"[^>]*content="light"\s*\/?>/.test(read(rel))) offenders.push(rel);
    }
  })("docs");
  ok(offenders.length === 0,
    `#26 no page pins color-scheme to light-only (${offenders.length} offenders${offenders.length ? ": " + offenders.join(", ") : ""})`,
    'docs/index.html — <meta name="color-scheme" content="light dark">');
}

// #27 local drill sketchpad mounts a shell and has a real exit
ok(!/var back = LOCAL \? "drill\.html" : "drill\.html"/.test(read("docs/ensemble/drilledit.html")),
  "#27 drilledit.html no longer has the pointless identical back-link branches");

// #23 ci-status watches real workflow names (delegates to the python guard)
ok(!/"Daily update"/.test(read(".github/workflows/ci-status.yml")),
  "#23 ci-status.yml no longer watches the nonexistent 'Daily update'");

console.log(`PASS ${pass.length}`);
pass.forEach((m) => console.log("  ok   " + m));
if (fail.length) {
  console.log(`FAIL ${fail.length}`);
  fail.forEach((f) => {
    console.log("  FAIL " + f.msg);
    if (f.fix) console.log("         fix → " + f.fix);
  });
  process.exit(1);
}
