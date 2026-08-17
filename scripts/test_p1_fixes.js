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
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass : fail).push(msg);

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

// #16 the dead prediction-reminder toggle is gone
ok(!/cad-notify-preds/.test(read("docs/app.js")),
  "#16 app.js no longer references the dead cad-notify-preds toggle");

// #17 slotMs uses a venue timezone, not a hardcoded EDT offset
ok(/tzOffsetMin\(zone/.test(read("docs/app.js")) && !/h \+ 4, \+m\[2\]\); \/\/ ET slot/.test(read("docs/app.js")),
  "#17 app.js slotMs converts via the venue timezone");
ok(/timeZone: "America\/New_York" \}\)\.format\(new Date\(ms\)\)/.test(read("docs/app.js")),
  "#17 app.js show-day flag computes the day in Eastern, not UTC");

// #18 combined standings expose a merged prev_score for the Biggest Move card
ok(/trend, prev_score: prev,/.test(read("docs/app.js")),
  "#18 app.js merged rows carry prev_score from the merged trend");

// #19 suggestions point at the current repo, not the old one
ok(/SUGGEST_REPO = "CadencePerformingArts\/Cadence-Labs"/.test(read("docs/app.js")),
  "#19 app.js suggestions repo is the current one");
ok(!/LukeBesel\/DCI-Tracker/.test(read("docs/app.js")),
  "#19 app.js has no LukeBesel/DCI-Tracker reference");

// #20 the switcher recognises unlisted circuits (won't mark DCI current there)
ok(/UNLISTED\s*=\s*\["boa"/.test(read("docs/modes.js")),
  "#20 modes.js here() recognises unlisted circuit apps");

// #22 purge tool clears the real key and writes the right index shape
{
  const s = read("scripts/purge_fabricated.py");
  ok(/cur\["performances"\] = \[\]/.test(s), "#22 purge clears 'performances', not 'perfs'");
  ok(/dump\(d \/ "db" \/ "index\.json", \[\]\)/.test(s), "#22 purge writes db/index.json as a list");
  ok(/DRY = /.test(s) && /--dry-run/.test(s), "#22 purge has a dry-run mode");
}

// #26 color-scheme meta allows dark mode everywhere
{
  const glob = require("child_process").execSync(
    "grep -rl 'name=\"color-scheme\"' docs --include=*.html", { cwd: ROOT }).toString().trim().split("\n");
  const bad = glob.filter((f) => /content="light"/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  ok(bad.length === 0, `#26 no page pins color-scheme to light-only (${bad.length} offenders)`);
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
  fail.forEach((m) => console.log("  FAIL " + m));
  process.exit(1);
}
