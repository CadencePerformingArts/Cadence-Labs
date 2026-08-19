#!/usr/bin/env node
/* Design guards for the private side (docs/ensemble/, my.html, the two admin
 * consoles).
 *
 * The workspace was redesigned onto app.css's primitives — .dsk2 / .dsk2.w75,
 * named grid areas, the min-width: 700px breakpoint, the shared .card. Every
 * check below guards a failure mode that is INVISIBLE in code review and
 * expensive to notice by eye:
 *
 *   1. an inline style="grid-template-columns:…" outranks the stylesheet, so
 *      the phone rule silently never applies (this exact bug clipped the WGI
 *      championship tiles to "Championshi");
 *   2. .acct-form / .acct-msg were lost in the stylesheet swap and restored
 *      into ensemble.css — a second copy, or a page-local copy that drifts,
 *      puts the sign-in form back where it was;
 *   3. a class a screen renders that no stylesheet defines renders as
 *      nothing, and looks like "that box just isn't styled yet";
 *   4. a var(--token) app.css doesn't define resolves to nothing at all —
 *      an invalid value, so the property is dropped;
 *   5. the phone dock and the More sheet are the only way to reach half the
 *      workspace on a 390px screen.
 *
 *   node scripts/test_workspace_design.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const ENS = path.join(DOCS, "ensemble");

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass : fail).push(msg);
const read = (p) => fs.readFileSync(p, "utf8");

const ensFiles = fs.readdirSync(ENS).filter((f) => /\.(html|js)$/.test(f));
const ensHtml = ensFiles.filter((f) => /\.html$/.test(f));
const APP_CSS = read(path.join(DOCS, "app.css"));
const ENS_CSS = read(path.join(ENS, "ensemble.css"));

/* every file this domain owns and may render markup from */
const OWNED = ensFiles.map((f) => ["ensemble/" + f, read(path.join(ENS, f))])
  .concat([
    ["my.html", read(path.join(DOCS, "my.html"))],
    ["my.js", read(path.join(DOCS, "my.js"))],
    ["ensembles.js", read(path.join(DOCS, "ensembles.js"))],
    ["starter.js", read(path.join(DOCS, "starter.js"))],
    ["admin-platform.html", read(path.join(DOCS, "admin-platform.html"))],
    ["ensemble-admin.html", read(path.join(DOCS, "ensemble-admin.html"))],
  ]);

/* the <style> blocks of one page, concatenated */
function pageCss(src) {
  return (src.match(/<style>[\s\S]*?<\/style>/g) || []).join("\n");
}

/* ── 1. no responsive grid is pinned by an inline style ────────────────
   An inline style is the highest-specificity author declaration there is,
   so `style="grid-template-columns: repeat(4, 1fr)"` survives every media
   query underneath it. The WGI tiles shipped that way once and clipped
   their own labels on a phone. Same for the scripted form. */
OWNED.forEach(([name, src]) => {
  const inline = (src.match(/style="[^"]*grid-template-columns[^"]*"/g) || [])
    .concat(src.match(/style='[^']*grid-template-columns[^']*'/g) || []);
  ok(inline.length === 0,
    `#1 ${name}: no inline grid-template-columns` +
    (inline.length ? ` — found ${inline.length}: ${inline[0].slice(0, 70)}` : ""));
  const scripted = src.match(/\.style\.gridTemplateColumns\s*=/g) || [];
  ok(scripted.length === 0,
    `#1 ${name}: nothing writes .style.gridTemplateColumns from script`);
});

/* Grid columns belong to a stylesheet, and a grid that is multi-column on a
   phone is a bug. Every grid-template-columns in the owned CSS must sit
   inside a media query, or declare a single track / an intrinsically
   responsive one (auto-fill, auto-fit, minmax with one track). */
function declarations(css) {
  // strip the bodies of @media blocks so what's left is the phone default
  let depth = 0, out = "", inMedia = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (css.startsWith("@media", i)) inMedia = depth + 1;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (inMedia && depth < inMedia) inMedia = 0; }
    if (!inMedia) out += c;
  }
  return out;
}
const PHONE_SAFE = /^\s*(none|minmax\(0,\s*1fr\)|1fr|repeat\(\s*(auto-fill|auto-fit)|repeat\(\s*2\s*,|minmax\(\s*\d+px)/;
/* grids whose columns ARE the content rather than a layout choice, so they
   are the same shape on a phone and a desktop. Named, with the reason. */
const NOT_A_LAYOUT = {
  ".ppl-kv": "a definition list: label column, value column",
  ".bil-kv": "a definition list: label column, value column",
  ".ops-month": "a month has seven days at every screen width",
};
[["ensemble.css", ENS_CSS]].concat(
  OWNED.filter(([n]) => /\.html$/.test(n)).map(([n, s]) => [n, pageCss(s)])
).forEach(([name, css]) => {
  const bad = [];
  const base = declarations(css);
  const re = /([^{}]*)\{[^{}]*grid-template-columns:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(base))) {
    const sel = m[1].split("\n").pop().trim(), val = m[2].trim();
    if (PHONE_SAFE.test(val)) continue;
    // the drill designer is a desktop tool whose rails collapse into sheets;
    // it is the one screen that is legitimately desktop-first.
    if (/^\.drill-/.test(sel)) continue;
    if (Object.keys(NOT_A_LAYOUT).some((k) => sel.split(/\s+/).pop() === k)) continue;
    bad.push(sel + " → " + val);
  }
  ok(bad.length === 0,
    `#1 ${name}: no grid is multi-column before a media query says so` +
    (bad.length ? ` — ${bad.join("; ")}` : ""));
});

/* ── 2. .acct-form / .acct-msg exist exactly once ──────────────────────
   They live in ensemble.css because the DCI-Tracker stylesheet swap dropped
   them out of app.css, and every workspace page renders them: the signed-out
   gate in core.js, the event editor in ops.js, the comment box in comms.js
   and the sign-in forms on admin/billing/event/files/forms/index/members/
   messages/music.html. */
/* every rule body whose selector list contains exactly `cls` (not
   `.cls .child`, not `.cls.mod`). Innermost blocks only, which is what a
   flat stylesheet is once @media wrappers are peeled off. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
function blocksFor(rawCss, cls) {
  const css = stripComments(rawCss);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split("{").pop().split(",").map((s) => s.trim());
    if (sels.indexOf(cls) >= 0) out.push(m[2].trim());
  }
  return out;
}
[".acct-form", ".acct-msg"].forEach((cls) => {
  const n = blocksFor(ENS_CSS, cls).length;
  ok(n === 1, `#2 ensemble.css defines ${cls} exactly once (found ${n})`);
  /* my.html is the one page outside /ensemble/ that renders these — it is
     not a workspace page and does not load ensemble.css, so it carries the
     only other copy. Both copies exist because the DCI-Tracker app.css no
     longer defines them; if it ever does again, delete both. What must not
     happen is the two drifting apart, so they are compared, not forbidden. */
  const mine = blocksFor(ENS_CSS, cls)[0] || "";
  const theirs = blocksFor(pageCss(read(path.join(DOCS, "my.html"))), cls)[0] || "";
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  ok(theirs && norm(mine) === norm(theirs),
    `#2 my.html's copy of ${cls} still matches ensemble.css's`);
  const others = OWNED.filter(([n2, s]) => n2 !== "my.html" && blocksFor(pageCss(s), cls).length)
    .map(([n2]) => n2);
  ok(others.length === 0,
    `#2 no workspace page re-declares ${cls}` + (others.length ? ` — ${others}` : ""));
});
ok(/\.acct-msg\.ok\b/.test(ENS_CSS) && /\.acct-msg\.err\b/.test(ENS_CSS),
  "#2 .acct-msg keeps its .ok / .err states — without them the status line never appears");

/* ── 3. shared surfaces are defined once, in the layer ─────────────────
   ops.js's event card renders on calendar.html AND event.html; people.js's
   rows on members.html AND admin.html; the preview sheet on files.html AND
   music.html; .ppl-actions on billing.html. Each used to live in whichever
   page's <style> happened to define it, so the same markup rendered styled
   on one screen and bare on the other. */
const SHARED = [".ops-card", ".ops-rsvp-b", ".ops-result", ".ops-toast", ".ops-f2",
  ".ppl-row", ".ppl-drawer", ".ppl-actions", ".ppl-perms", ".ppl-toast",
  ".fl-modal", ".fl-chip", ".fl-tag"];
SHARED.forEach((cls) => {
  ok(blocksFor(ENS_CSS, cls).length >= 1, `#3 ensemble.css owns ${cls}`);
  /* A page may still LAYER on a shared surface — event.html makes the RSVP
     buttons a size larger because they are that screen's primary action.
     What must not come back is a page carrying a full second copy, which is
     how these drifted in the first place, so the guard counts declarations
     rather than forbidding the selector. */
  const copies = OWNED.filter(([, s]) =>
    blocksFor(pageCss(s), cls).some((b) => b.split(";").filter((x) => x.trim()).length >= 3))
    .map(([n]) => n);
  ok(copies.length === 0,
    `#3 no page keeps a full second copy of ${cls}` + (copies.length ? ` — ${copies}` : ""));
});

/* ── 4. nothing renders a class no stylesheet defines ──────────────────
   A missing class is silent: the markup is there, the box just has no
   styling and looks half-finished. Only the literal head of a class
   attribute is read (up to the first quote or +), so template expressions
   never masquerade as class names. */
const HOOKS = {
  // selector hooks with no styling of their own, on purpose
  "ens-cform": "comms.js finds its comment form by it; .acct-form does the styling",
  "ops-rsvp-slot": "ops.js mounts the RSVP control into it",
  "eGrp": "ops.js reads the checked group checkboxes by it",
};
const styleCtx = APP_CSS + ENS_CSS +
  ensHtml.map((f) => pageCss(read(path.join(ENS, f)))).join("\n") +
  pageCss(read(path.join(DOCS, "my.html"))) +
  pageCss(read(path.join(DOCS, "admin-platform.html"))) +
  pageCss(read(path.join(DOCS, "ensemble-admin.html"))) +
  read(path.join(ENS, "core.js")) +            // notifCss() injects the bell's rules
  read(path.join(DOCS, "ensembles.js")) +      // both inject their own <style>
  read(path.join(DOCS, "starter.js"));
const undefinedClasses = [];
OWNED.forEach(([name, src]) => {
  const seen = new Set();
  const re = /class=(["'])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    m[2].split(/['+]/)[0].split(/\s+/).forEach((t) => {
      if (/^[a-zA-Z][\w-]*$/.test(t)) seen.add(t);
    });
  }
  seen.forEach((cls) => {
    if (HOOKS[cls]) return;
    if (new RegExp("\\." + cls.replace(/[-]/g, "\\-") + "(?![\\w-])").test(styleCtx)) return;
    undefinedClasses.push(name + " → ." + cls);
  });
});
ok(undefinedClasses.length === 0,
  "#4 every class a workspace screen renders is defined in app.css, ensemble.css " +
  "or that page's own <style>" +
  (undefinedClasses.length ? ` — ${undefinedClasses.slice(0, 8).join(", ")}` : ""));

/* ── 5. every custom property resolves ─────────────────────────────────
   var(--nope) with no fallback makes the whole declaration invalid, so the
   property is dropped and the element renders with the inherited value —
   a colour that is silently wrong rather than obviously missing. */
const appTokens = new Set((APP_CSS.match(/--[\w-]+\s*:/g) || [])
  .map((s) => s.replace(/\s*:$/, "")));
function danglingTokens(css) {
  const own = new Set((css.match(/--[\w-]+\s*:/g) || []).map((s) => s.replace(/\s*:$/, "")));
  const out = [];
  const re = /var\(\s*(--[\w-]+)\s*(,)?/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[2]) continue;                       // has a fallback, always resolves
    if (appTokens.has(m[1]) || own.has(m[1])) continue;
    out.push(m[1]);
  }
  return [...new Set(out)];
}
const ensDangling = danglingTokens(ENS_CSS);
ok(ensDangling.length === 0,
  "#5 every custom property ensemble.css uses is defined in app.css" +
  (ensDangling.length ? ` — ${ensDangling.join(", ")}` : ""));
ensHtml.forEach((f) => {
  const d = danglingTokens(pageCss(read(path.join(ENS, f))));
  ok(d.length === 0, `#5 ${f}: every var() resolves` + (d.length ? ` — ${d.join(", ")}` : ""));
});
ok(appTokens.has("--muted") && appTokens.has("--accent-wash") && appTokens.has("--series-1"),
  "#5 the token set the design language names is still in app.css");

/* ── 6. the phone rail and the More sheet still work at 390px ──────────
   Nine sections do not fit a phone. The four daily ones plus More make the
   dock; the rest fold into the sheet. Break either and half the workspace
   becomes unreachable one-handed. */
const CORE = read(path.join(ENS, "core.js"));
const phoneBlock = (ENS_CSS.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\n\}/) || [""])[0];
ok(/\.ens-tabs\s*\{[^}]*position:\s*fixed/.test(phoneBlock),
  "#6 the section rail becomes a fixed dock at ≤640px");
ok(/bottom:\s*0/.test(phoneBlock) && /\.ens-tabs/.test(phoneBlock),
  "#6 the dock sits on the bottom edge, in thumb reach");
ok(/\.ens-tab\.sec\s*\{\s*display:\s*none/.test(phoneBlock),
  "#6 the folded sections leave the dock on a phone (.ens-tab.sec is hidden)");
ok(/body\.ens main\s*\{[^}]*padding-bottom:\s*1\d\dpx/.test(phoneBlock),
  "#6 the page reserves room under the dock so the last row is not covered");
ok(/env\(safe-area-inset-bottom\)/.test(phoneBlock),
  "#6 the dock clears the home indicator");
ok(/\.ens-tab\.ens-more/.test(ENS_CSS) &&
   /@media \(min-width: 641px\) \{ \.ens-tab\.ens-more \{ display: none/.test(ENS_CSS),
  "#6 More is a phone control — desktop has room for the whole rail");
ok(/id="ensMoreBtn"/.test(CORE) && /function openMoreSheet/.test(CORE),
  "#6 core.js still renders the More button and its sheet");
/* every section marked sec: true must be reachable from the sheet */
const secs = (CORE.match(/^\s{4}(\w+):\s*\{[^}]*sec:\s*true/gm) || [])
  .map((s) => s.trim().split(":")[0]);
ok(secs.length >= 5, `#6 the sections that fold into More are still marked (${secs.length})`);
const sheetBody = (CORE.match(/function openMoreSheet[\s\S]*?\n  \}/) || [""])[0];
ok(/!s\.sec/.test(sheetBody) && /sectionVisible\(k\)/.test(sheetBody),
  "#6 the More sheet lists exactly the folded sections the viewer may see");
ok(/ens-sheet-row/.test(sheetBody) && /ensMoreClose/.test(sheetBody),
  "#6 the sheet uses the shared sheet rows and can be closed");
ok(/\.ens-sheet\s*\{[^}]*position:\s*fixed[^}]*\}/.test(ENS_CSS) &&
   /align-items:\s*flex-end/.test(ENS_CSS),
  "#6 sheets come up from the bottom of a phone");
ok(/@media \(min-width: 620px\) \{ \.ens-sheet \{ align-items: center/.test(ENS_CSS),
  "#6 …and are centred once there is room");

/* ── 7. the two halves layer in the right order ────────────────────────
   ensemble.css adds to app.css; loaded the other way round, app.css would
   win every tie and the workspace chrome would come apart. */
ensHtml.forEach((f) => {
  const src = read(path.join(ENS, f));
  const a = src.indexOf('href="../app.css"');
  const e = src.indexOf('href="ensemble.css"');
  ok(a >= 0 && e > a, `#7 ${f} loads app.css, then ensemble.css`);
});

/* ── 8. the workspace builds on the shared primitives ──────────────────
   Not a style opinion: if these disappear the screens have quietly gone
   back to one stretched column. */
const usesDsk2 = ensHtml.filter((f) => /class="[^"]*\bdsk2\b/.test(read(path.join(ENS, f))));
ok(usesDsk2.length >= 4,
  `#8 the workspace pairs cards with app.css's .dsk2 (${usesDsk2.length} pages)`);
ok(/@media \(min-width: 700px\)/.test(ENS_CSS),
  "#8 ensemble.css turns at the 700px breakpoint app.css turns at");
const wideGrids = ["cal-grid", "feed-grid", "ppl-grid", "fl-browse"];
wideGrids.forEach((g) => {
  const re = new RegExp("\\." + g + "\\s*\\{[\\s\\S]*?min-width: 0|\\." + g + " > \\*\\s*\\{[^}]*min-width: 0");
  const owner = ensHtml.find((f) => new RegExp("\\." + g + "\\b").test(pageCss(read(path.join(ENS, f)))));
  ok(!!owner, `#8 .${g} is declared by the screen that uses it`);
  if (owner) {
    ok(re.test(pageCss(read(path.join(ENS, owner)))),
      `#8 .${g} carries min-width: 0 on its tracks, so a wide table scrolls ` +
      "inside its card instead of stretching the page");
  }
});

/* ── report ─────────────────────────────────────────────────────────── */
console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length) {
  fail.forEach((f) => console.log("  FAIL  " + f));
  console.log("");
  process.exit(1);
}
pass.forEach((p) => console.log("  ok    " + p));
