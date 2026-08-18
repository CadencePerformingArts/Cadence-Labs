#!/usr/bin/env node
/* Regression guards for the workspace UX holes (#15, #16, #18, #19, #20, #23).
 *
 * All of these were surfaces that looked finished and weren't: links that
 * changed the URL and nothing else, a paid subscription with no desktop
 * door, a required question no member could ever answer, a quick action for
 * a feature that has no screen, and copy that described a flow nobody
 * built. Each one is cheap to assert at the source level and would be
 * expensive to notice again by hand.
 *
 *   node scripts/test_workspace_ux.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const ENS = path.join(ROOT, "docs", "ensemble");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass : fail).push(msg);

const ensFiles = fs.readdirSync(ENS).filter((f) => /\.(html|js)$/.test(f));
const ensAll = ensFiles.map((f) => fs.readFileSync(path.join(ENS, f), "utf8")).join("\n");
const adm = read("docs/ensemble/admin.html");
const forms = read("docs/ensemble/forms.html");

/* the body of one top-level function inside a page's IIFE, from its
   `function name(` to the next one at the same indent */
function bodyOf(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  const j = src.indexOf("\n  function ", i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

/* ── #15 a same-page fragment link needs a hashchange listener ─────────
   `<a href="admin.html#forms">` on admin.html is a same-document navigation:
   the browser sets location.hash and fires hashchange, and reloads nothing.
   Any page that links to its own hash routes must listen for that. */
ensFiles.filter((f) => /\.html$/.test(f)).forEach((f) => {
  const src = fs.readFileSync(path.join(ENS, f), "utf8");
  const self = new RegExp('"' + f.replace(".", "\\.") + "#", "g");
  const selfLinks = (src.match(self) || []).length;
  if (!selfLinks) return;
  ok(/addEventListener\("hashchange"/.test(src),
    `#15 ${f}: ${selfLinks} self-hash link(s) and a hashchange listener to route them`);
});
ok(/"admin\.html#forms"/.test(adm) && /addEventListener\("hashchange"/.test(adm),
  "#15 admin.html routes its own #tab links instead of only reading the hash at boot");
ok(/function tabFromHash\(\)/.test(adm) && (adm.match(/tabFromHash\(\)/g) || []).length >= 3,
  "#15 admin.html boot and hashchange share one hash→tab router");

/* ── #16 billing is reachable on a desktop ────────────────────────────
   core.js files billing under Admin (`parent: "admin"`), so it renders no
   tab of its own, and the More sheet that carries its link is hidden above
   640px. While that is true, Admin must carry a first-class entry. */
{
  const core = read("docs/ensemble/core.js");
  const billingIsSubpage = /billing:\s*\{\s*parent:\s*"admin"/.test(core);
  const dash = bodyOf(adm, "dashboardHtml");
  const hasQuick = /\["Plan & billing",\s*"billing\.html"\]/.test(dash);
  const hasTile = /tile\("billing\.html"/.test(adm) && /billingTile\(\)/.test(dash);
  ok(!billingIsSubpage || hasQuick,
    "#16 admin.html has a Plan & billing quick action while billing has no tab of its own");
  ok(!billingIsSubpage || hasTile,
    "#16 admin.html has a billing tile while billing has no tab of its own");
  ok(/function canBilling\(\)/.test(adm) && /can\("billing\.manage"\)/.test(adm),
    "#16 the billing entry is gated on billing.manage / org.admin");
}

/* ── #18 a required file upload can never be answered ─────────────────
   The member fill-in screen renders no control for a file field (uploads
   aren't wired to storage), so `required` on one locks every member out of
   the whole form. Two guards: the builder can't create one, and the fill-in
   screen doesn't enforce one that is already stored. */
{
  const m = /function isRequired\(fd\) \{[^}]*\}/.exec(forms);
  ok(!!m, "#18 forms.html has a single isRequired() gate for required answers");
  if (m) {
    const isRequired = vm.runInNewContext("(" + m[0].replace(/^function isRequired/, "function") + ")");
    ok(isRequired({ required: true, field_type: "file" }) === false,
      "#18 forms.html never treats a file field as required");
    ok(isRequired({ required: true, field_type: "text" }) === true,
      "#18 forms.html still enforces every other required field");
    ok(isRequired({ required: false, field_type: "text" }) === false,
      "#18 forms.html leaves optional fields optional");
  }
  const collect = bodyOf(forms, "collect");
  ok(!/\bfd\.required\b/.test(collect) && /isRequired\(fd\) &&/.test(collect),
    "#18 forms.html collect() validates through isRequired(), not the raw fd.required flag");
  ok(/function syncFieldRow\(row\)/.test(adm) && /req\.disabled = isFile/.test(adm),
    "#18 admin.html disables Required when a field's type is File upload");
  ok(/required: r\.querySelector\('\[data-f="required"\]'\)\.checked && type !== "file"/.test(adm),
    "#18 admin.html refuses to store required=true on a file field");
}

/* ── #19 a quick action must lead somewhere that has the feature ──────
   Polls and Tasks are sold on the plan cards and have schema in 0007, but
   no screen builds one. A quick action naming a feature with no UI is a
   link to nowhere. */
{
  const dash = bodyOf(adm, "dashboardHtml");
  const quick = [...dash.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((x) => [x[1], x[2]]);
  ok(quick.length >= 5, `#19 admin.html quick actions parsed (${quick.length} found)`);
  const FEATURE_TABLES = { poll: "org_polls", task: "org_tasks", signup: "org_signups" };
  quick.forEach((q) => {
    const file = q[1].split("#")[0];
    ok(fs.existsSync(path.join(ENS, file)), `#19 quick action "${q[0]}" targets a page that exists`);
    Object.keys(FEATURE_TABLES).forEach((word) => {
      if (q[0].toLowerCase().indexOf(word) < 0) return;
      ok(ensAll.indexOf(FEATURE_TABLES[word]) >= 0,
        `#19 quick action "${q[0]}" names a feature some screen actually reads (${FEATURE_TABLES[word]})`);
    });
  });
  ok(!/"Create poll"/.test(adm),
    "#19 the Create poll quick action is gone until a polls surface exists");
}

/* ── #20 the Requests tab explains why it is empty ────────────────────
   Nothing in docs/ inserts an org_access_request — the table has an insert
   policy and a reviewer UI, and no writer. While that holds, the copy must
   not promise a route that doesn't exist. */
{
  const writesRequests = ensFiles.some((f) => {
    const s = fs.readFileSync(path.join(ENS, f), "utf8");
    return /rest\("org_access_requests",\s*\{\s*method:\s*"POST"/.test(s) ||
           /org_access_requests[^)]*method: "POST"/.test(s);
  });
  ok(writesRequests || !/public Cadence profile and ask/.test(adm),
    "#20 admin.html no longer claims requests arrive from a public profile nobody built");
  ok(writesRequests || /members\.html#invites/.test(bodyOf(adm, "requestsHtml")),
    "#20 the Requests tab points at invites, the way in that does exist");
}

/* ── #23 the form builder describes the product that shipped ──────────── */
{
  ok(fs.existsSync(path.join(ENS, "forms.html")),
    "#23 the member fill-in screen exists");
  ok(!/fill-in screen ships with the forms phase/.test(adm),
    "#23 admin.html no longer tells directors the fill-in screen isn't built");
  ok(/Members fill these in on their Forms tab/.test(adm),
    "#23 admin.html points directors at the screen that exists");
  ok(/target_group_ids: targets/.test(adm) && /id="fGroups"/.test(adm),
    "#23 the builder can target a form at groups (0009 target_group_ids)");
  ok(/function targetLabel\(f\)/.test(adm),
    "#23 the forms list shows who each form is aimed at");
}

/* ── every inline script on the pages above still parses ─────────────── */
["docs/ensemble/admin.html", "docs/ensemble/forms.html", "docs/ensemble/home.html",
 "docs/ensemble/members.html"].forEach((f) => {
  const src = read(f);
  let bad = 0;
  (src.match(/<script>[\s\S]*?<\/script>/g) || []).forEach((b) => {
    try { new vm.Script(b.replace(/^<script>/, "").replace(/<\/script>$/, "")); }
    catch (e) { bad++; }
  });
  ok(bad === 0, `${f}: every inline script parses`);
});

console.log(`PASS ${pass.length}`);
pass.forEach((m) => console.log("  ok   " + m));
if (fail.length) {
  console.log(`FAIL ${fail.length}`);
  fail.forEach((m) => console.log("  FAIL " + m));
  process.exit(1);
}
