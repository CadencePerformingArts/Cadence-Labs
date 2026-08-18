#!/usr/bin/env node
/* Regression guards for the workspace UX holes (#15, #16, #18, #19, #20, #23).
 *
 * All of these were surfaces that looked finished and weren't: links that
 * changed the URL and nothing else, a paid subscription with no desktop
 * door, a required question no member could ever answer, a quick action for
 * a feature that has no screen, and copy that described a flow nobody
 * built. Each one is cheap to assert and would be expensive to notice
 * again by hand.
 *
 * Where a hole is behavioural, the guard is too: the router, the boot
 * permission gate, the field-row sync and the member field renderer are
 * lifted straight out of the shipped pages and executed here against
 * stubs, so reverting the fix turns the check red instead of leaving a
 * source string that still happens to match.
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

/* one `var NAME = [ … ];` declaration, verbatim */
function declOf(src, name) {
  const m = new RegExp("var " + name + " = \\[[\\s\\S]*?\\];").exec(src);
  return m ? m[0] : "";
}

/* visible words only — attribute values (title="…", aria-label="…") are
   exactly what "nobody reads this on a phone" means, so they don't count */
function visibleText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
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

/* Run admin.html's real router. TABS + tabFromHash() + the hashchange
   listener are lifted out of the page and executed against a fake
   window/location, so every assertion below is about what the router
   does, not about what the file says. */
function router(state) {
  const tabs = declOf(adm, "TABS");
  const h0 = adm.indexOf("function tabFromHash()");
  const h1 = adm.indexOf("\n  function render()", h0);
  if (!tabs || h0 < 0 || h1 < 0) return null;
  const sandbox = {
    S: state,
    location: { hash: "" },
    renders: [],
    render: function () { sandbox.renders.push(sandbox.S.tab); },
    window: {
      addEventListener: function (ev, fn) { if (ev === "hashchange") sandbox.onhash = fn; },
      scrollTo: function () {},
    },
    onhash: null,
  };
  vm.runInNewContext(tabs + "\n" + adm.slice(h0, h1), sandbox);
  sandbox.go = function (hash) { sandbox.location.hash = hash; sandbox.onhash(); };
  return sandbox;
}

{
  /* entry A: admin.html with no hash. Click "Open forms" (entry B,
     "#forms"), then press Back. The URL returns to the hashless entry and
     hashchange fires with location.hash === "". An empty or unknown hash
     has to mean the Dashboard — the pane on screen must not outlive the
     URL that put it there. */
  const r = router({ org: { name: "Org" }, ready: true, tab: "dashboard" });
  ok(!!r, "#15 admin.html's hash router could be lifted out and executed");
  if (r) {
    r.go("#forms");
    ok(r.S.tab === "forms" && r.renders.length === 1,
      "#15 a self-hash link routes to its tab (forms) and repaints");
    r.go("");
    ok(r.S.tab === "dashboard" && r.renders.length === 2,
      "#15 Back to the hashless entry returns to the Dashboard instead of stranding the old pane");

    r.S.tab = "roles";
    r.go("#nosuchtab");
    ok(r.S.tab === "dashboard",
      "#15 an unknown hash falls back to the Dashboard rather than being ignored");

    const before = r.renders.length;
    r.go("#dashboard");
    ok(r.renders.length === before,
      "#15 a hash change that names the tab already on screen repaints nothing");
  }
}

/* ── the hash router may not outrun the page's permission gate ─────────
   S.org is assigned before the org.admin / member.manage / audit.view
   check and on the load()-failure path, so it cannot be the signal that
   the Admin shell is safe to paint: a plain member who typed
   admin.html#roles, or pressed Back, would have got the whole shell —
   including the Roster / Attendance / Announcements CSV exports — over
   the deny screen. S.ready is set only after both hurdles are cleared. */
{
  const denied = router({ org: { name: "Org" }, ready: false, tab: "dashboard" });
  if (denied) {
    denied.go("#roles");
    ok(denied.renders.length === 0 && denied.S.tab === "dashboard",
      "gate: a hash change paints nothing while the page is not ready, even with S.org set");
  }
  ok(/if \(!S\.ready\) return;/.test(adm),
    "gate: the hashchange listener's first act is to check S.ready");
}

/* …and the boot path is what sets that flag. The CadOrg.start() callback
   is lifted out and run three times: denied, load-failed, and healthy. */
function boot(opts) {
  const marker = 'CadOrg.start({ nav: "admin" }).then(async function (org) {';
  const i = adm.indexOf(marker);
  if (i < 0) return null;
  const j = adm.indexOf("\n  });", i);
  if (j < 0) return null;
  const body = adm.slice(i + marker.length, j);
  const sandbox = {
    S: { org: null, ready: false, tab: "dashboard" },
    main: { innerHTML: "" },
    CadOrg: { can: function () { return !!opts.allowed; } },
    tabFromHash: function () { return null; },
    load: function () {
      return opts.loadFails ? Promise.reject(new Error("no such table")) : Promise.resolve();
    },
    renders: 0,
    render: function () { sandbox.renders++; },
  };
  vm.runInNewContext("run = async function (org) {" + body + "\n};", sandbox);
  return sandbox;
}

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
   the whole form. Three guards, all behavioural: the builder row disables
   Required, the create handler refuses to store it, and the fill-in screen
   doesn't enforce one that is already stored. */
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

  /* the builder's own row, run against a fake row element */
  const sync = bodyOf(adm, "syncFieldRow");
  const fakeRow = (type) => {
    const cells = {
      type: { value: type },
      required: { checked: true, disabled: false },
      reqlabel: { style: {}, title: "" },
    };
    return { cells, querySelector: (sel) => cells[/data-f="([a-z]+)"/.exec(sel)[1]] || null };
  };
  const sb = { row: null };
  vm.runInNewContext(sync, sb);
  const fileRow = fakeRow("file");
  sb.syncFieldRow(fileRow);
  ok(fileRow.cells.required.checked === false && fileRow.cells.required.disabled === true,
    "#18 admin.html unchecks and disables Required the moment a field becomes a file field");
  const textRow = fakeRow("text");
  sb.syncFieldRow(textRow);
  ok(textRow.cells.required.disabled === false,
    "#18 admin.html leaves Required usable on every other field type");

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
  ok(!/fill-in screen ships with the forms phase/.test(adm),
    "#23 admin.html no longer tells directors the fill-in screen isn't built");
  ok(/Members fill these in on their Forms tab/.test(adm),
    "#23 admin.html points directors at the screen that exists");
  ok(/target_group_ids: targets/.test(adm) && /id="fGroups"/.test(adm),
    "#23 the builder can target a form at groups (0009 target_group_ids)");
  ok(/function targetLabel\(f\)/.test(adm),
    "#23 the forms list shows who each form is aimed at");

  /* Every type the builder offers must draw something sensible on the
     member's screen. forms.html's fieldHtml() is run for each one; a type
     the test has never heard of fails until someone says what it should
     render, and a renderer that quietly stops emitting a control fails
     immediately. (Replaces an existsSync() on a file this script has
     already read at line 32 — a check that could never go red.) */
  const types = [...declOf(adm, "FIELD_TYPES").matchAll(/\["([a-z]+)",\s*"([^"]+)"\]/g)]
    .map((x) => [x[1], x[2]]);
  ok(types.length >= 8, `#23 the builder's FIELD_TYPES parsed (${types.length} types)`);

  const fsb = { esc: (s) => String(s == null ? "" : s) };
  const isReqSrc = /function isRequired\(fd\) \{[^}]*\}/.exec(forms);
  try { vm.runInNewContext((isReqSrc ? isReqSrc[0] : "") + "\n" + bodyOf(forms, "fieldHtml"), fsb); }
  catch (e) { /* fieldHtml stays undefined; every draw() below then fails loudly */ }
  const draw = (t) => fsb.fieldHtml(
    { id: "x1", label: "Question", field_type: t, options: ["Alpha", "Beta"], required: true }, null);
  const count = (h, re) => (h.match(re) || []).length;
  const EXPECT = {
    text: (h) => /<input class="ctrl"/.test(h),
    longtext: (h) => /<textarea class="ctrl"/.test(h),
    number: (h) => /type="number"/.test(h),
    date: (h) => /type="date"/.test(h),
    select: (h) => /<select class="ctrl"/.test(h) && count(h, /<option/g) >= 3,
    multiselect: (h) => count(h, /<input[^>]*type="checkbox"/g) === 2,
    checkbox: (h) => count(h, /<input[^>]*type="checkbox"/g) === 1,
    signature: (h) => /<input class="ctrl"/.test(h),
    /* the whole point: a file field draws NO control, and says why */
    file: (h) => !/<input|<select|<textarea/.test(h) && /aren't supported/.test(h),
  };
  types.forEach((t) => {
    const check = EXPECT[t[0]];
    if (!check) {
      ok(false, `#23 the builder offers "${t[0]}" but this test doesn't know what the member ` +
        "screen should render for it — teach it, or drop the type");
      return;
    }
    let html = "";
    try { html = draw(t[0]); } catch (e) { html = ""; }
    ok(check(html), `#23 the member screen renders a "${t[1]}" field the way that type needs`);
  });

  /* #3: the file type's caveat has to be somewhere a director reads. A
     title= tooltip on a greyed-out checkbox is invisible on a phone, so
     the assertion is on the builder's rendered *visible* text. */
  const hasFile = types.some((t) => t[0] === "file");
  let builderText = "";
  {
    const sb = {
      S: { forms: [], groups: [{ id: "g1", name: "Brass" }] },
      canForms: () => true,
      esc: (s) => String(s == null ? "" : s),
      P: { fmtDate: () => "Jan 1" },
    };
    try {
      vm.runInNewContext(
        declOf(adm, "FORM_KINDS") + "\n" + bodyOf(adm, "targetLabel") + "\n" + bodyOf(adm, "formsHtml"), sb);
      builderText = visibleText(sb.formsHtml());
    } catch (e) { builderText = ""; }
    ok(builderText.length > 200, "#23 admin.html's form builder could be rendered for inspection");
  }
  ok(!hasFile || /off-form/i.test(builderText),
    "#23/#3 the builder says on screen — not in a tooltip — that file answers are collected off-form");

  /* #4: org_form_visible() short-circuits on org_has_perm(form.manage)
     before it ever looks at target_group_ids, so "only members of the
     groups you pick" was false for every staff member on the page. */
  const who = builderText.slice(builderText.indexOf("Who sees it"));
  ok(builderText.indexOf("Who sees it") >= 0 && who.indexOf("form.manage") >= 0,
    "#23/#4 the 'Who sees it' help admits that form.manage staff see every form");
  ok(!/only members of the groups you pick/i.test(builderText),
    "#23/#4 the 'Who sees it' help no longer claims targeting hides a form from staff");
}

/* the claim above is only worth making because the SQL still reads that
   way — if org_form_visible() ever stops short-circuiting on form.manage,
   this fails and the copy gets to be simpler again */
{
  const sql = read("supabase/migrations/0009_ensemble_people.sql");
  const fn = sql.slice(sql.indexOf("function public.org_form_visible"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  const perm = body.indexOf("org_has_perm(f.org_id, 'form.manage')");
  const target = body.indexOf("target_group_ids");
  ok(perm >= 0 && target > perm,
    "#23/#4 org_form_visible() really does clear form.manage staff before it checks targeting");
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

/* ── the boot gate, which is async, then the report ──────────────────── */
(async function () {
  const denied = boot({ allowed: false });
  ok(!!denied, "gate: admin.html's CadOrg.start() callback could be lifted out and executed");
  if (denied) {
    await denied.run({ id: "o1", name: "Org" });
    ok(denied.S.ready === false && denied.renders === 0 &&
       /directors and staff/.test(denied.main.innerHTML),
      "gate: a member without org.admin / member.manage / audit.view gets the deny screen and no ready flag");

    const broke = boot({ allowed: true, loadFails: true });
    await broke.run({ id: "o1", name: "Org" });
    ok(broke.S.ready === false && broke.renders === 0,
      "gate: a failed load() leaves the page not-ready, so a later hash change can't paint over the error");

    const good = boot({ allowed: true });
    await good.run({ id: "o1", name: "Org" });
    ok(good.S.ready === true && good.renders === 1,
      "gate: a director who loads cleanly is ready, and the page paints once");
  }
})().then(() => {
  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) {
    console.log(`FAIL ${fail.length}`);
    fail.forEach((m) => console.log("  FAIL " + m));
    process.exit(1);
  }
}, (e) => { console.error(e); process.exit(1); });
