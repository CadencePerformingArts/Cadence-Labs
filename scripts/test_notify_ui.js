#!/usr/bin/env node
/* Tests for the in-app notification reader in docs/ensemble/core.js.
 *
 *   node scripts/test_notify_ui.js
 *
 * Migration 0014 queues an 'inapp' row for every acknowledgment-required
 * announcement and RSVP-required event, and its RLS exists for one reader:
 * the recipient's own browser. Nothing read that queue until the bell. What
 * this asserts, by driving the REAL core.js against a fake browser and a
 * fake PostgREST rather than a reimplementation:
 *
 *   • the reader hits org_notifications with the right filters — in-app,
 *     unread, this workspace — and adds NO client-side recipient filter,
 *     because notif_read_own already is that filter;
 *   • read_at is the only column it ever writes, which is exactly what
 *     guard_notification_update() allows a recipient to touch;
 *   • the badge is reconciled against the list it filtered, so a row
 *     dismissed twice moves the number once, and it never goes negative;
 *   • tapping a notification that points at the page you are already on
 *     still takes the sheet down and still routes the deep link, instead of
 *     leaving a dead sheet over an unchanged page (a same-document fragment
 *     change fires no navigation, and nothing here listens for hashchange);
 *   • a failed "Mark all read" says so instead of silently redrawing;
 *   • the preference surface offers only channels something actually
 *     consults, writes values 0006's CHECK constraints accept, and folds a
 *     channel away with a note (rather than throwing) when the database
 *     refuses it — the case for 'inapp' until 0019 widens the column.
 *
 * The sheet assertions drive the real openers and the real click/keydown
 * handlers; where a check reads source text it is because the fact lives in
 * another file (notify-worker.js's links, the migrations' CHECK).
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n) => { for (let i = 0; i < (n || 4); i++) await tick(); };

/* ── a browser small enough to fit in a test ──────────────────────────── */
// core.js reads bare globals (document, fetch, location) as well as
// window.*, so here window IS the global object.
global.window = global;
global.CAD_SUPABASE = { url: "https://db.test", publishableKey: "pk_test" };

const BASE = "https://db.test/rest/v1/";
const calls = [];
let handler = () => ({ status: 200, body: [] });
const last = () => calls[calls.length - 1];

global.fetch = async (url, opts) => {
  const o = opts || {};
  const call = {
    path: String(url).replace(BASE, ""),
    method: o.method || "GET",
    headers: o.headers || {},
    body: o.body ? JSON.parse(o.body) : null,
  };
  calls.push(call);
  const r = handler(call) || { status: 200, body: [] };
  return {
    ok: r.status < 400,
    status: r.status,
    text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
  };
};

const els = {};
const created = [];
function node(tag) {
  return {
    tag, id: "", className: "", innerHTML: "", textContent: "", hidden: false,
    attrs: {}, listeners: {}, removed: false, focused: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); },
    appendChild() {}, remove() { this.removed = true; }, focus() { this.focused++; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
// every sheet trapSheet() opens registers a document keydown handler; keeping
// them lets the test press Escape for real instead of asserting on source
const keys = [];
global.document = {
  body: { appendChild() {} },
  head: { appendChild() {} },
  activeElement: null,
  getElementById: (id) => els[id] || null,
  createElement: (tag) => { const n = node(tag); created.push(n); return n; },
  addEventListener(t, fn) { if (t === "keydown") keys.push(fn); },
  removeEventListener(t, fn) { const i = keys.indexOf(fn); if (i >= 0) keys.splice(i, 1); },
};
const escape_ = () => keys.slice().forEach((fn) => fn({ key: "Escape", preventDefault() {} }));

/* a location that records what a navigation WOULD have done */
function at(page, search) {
  global.location = {
    pathname: "/ensemble/" + page, search: search || "", hash: "", href: "",
    reloads: 0, reload() { this.reloads++; },
  };
  return global.location;
}
at("home.html");

/* the sheets core.js builds, newest last */
const sheets = () => created.filter((n) => n.className === "ens-sheet");
const lastSheet = () => sheets()[sheets().length - 1];
const sheetNamed = (label) => sheets().filter((n) => n.attrs["aria-label"] === label).pop();

/* the href core.js actually rendered for a notification row — the test
   follows what the member would tap, not a URL it made up itself */
const hrefOf = (html, id) =>
  (new RegExp('href="([^"]*)" data-notif="' + id + '"').exec(html) || [])[1];

/* what the member reads, not what the markup spells: core.js escapes every
   string it renders, so "Couldn't" arrives as "Couldn&#39;t" */
const text = (html) => String(html || "")
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* click a rendered notification row the way a browser delivers it */
function tapRow(sheet, id, href) {
  const row = {
    id: "",
    getAttribute: (k) => (k === "href" ? href : k === "data-notif" ? id : null),
  };
  let prevented = 0;
  sheet.fire("click", {
    target: { id: "", closest: (sel) => (sel === "[data-notif]" ? row : null) },
    preventDefault() { prevented++; },
  });
  return () => prevented;
}
const tapButton = (sheet, id) =>
  sheet.fire("click", { target: { id, closest: () => null }, preventDefault() {} });

new Function(read("docs/ensemble/core.js"))();
const CadOrg = global.CadOrg;
ok(!!CadOrg && !!CadOrg._notif, "core.js loads and exposes the notification internals");

/* ── the query: right table, right filters, no client-side security ───── */
{
  const q = CadOrg._notif.query("org-1", 30);
  ok(q.indexOf("org_notifications?") === 0, "the reader queries org_notifications");
  ok(/[?&]channel=eq\.inapp(&|$)/.test(q), "query: in-app channel only");
  ok(/[?&]read_at=is\.null(&|$)/.test(q), "query: unread rows only");
  ok(/[?&]status=neq\.canceled(&|$)/.test(q), "query: withdrawn rows excluded");
  ok(!/status=eq\.sent/.test(q),
    "query: does NOT require status='sent' (an undeployed worker must not empty the bell)");
  ok(/[?&]org_id=eq\.org-1(&|$)/.test(q), "query: scoped to the workspace on screen");
  ok(!/recipient_member_id|recipient_email|user_id/.test(q),
    "query: no client-side recipient filter — notif_read_own is the filter");
  ok(/order=created_at\.desc/.test(q) && /limit=30/.test(q), "query: newest first, bounded");
  const cols = (q.match(/select=([^&]*)/) || [])[1] || "";
  ok(cols.split(",").every((c) => ["id", "type", "priority", "payload", "created_at"].includes(c)),
    "query: selects only template-safe columns (no last_error, no dedupe_key)");
}

/* ── deep links land where notify-worker.js's render() sends them ─────── */
{
  const worker = read("push-server/notify-worker.js");
  ok(CadOrg._notif.link({ type: "ack_post", payload: { post_id: "p1" } }) === "feed.html#post-p1",
    "ack_post opens feed.html#post-<id>");
  ok(worker.includes("/ensemble/feed.html#post-${p.post_id"),
    "…the same place notify-worker.js render() sends ack_post");
  ok(CadOrg._notif.link({ type: "rsvp", payload: { event_id: "e1" } }) === "event.html?id=e1",
    "rsvp opens event.html?id=<id>");
  ok(worker.includes("/ensemble/event.html?id=${p.event_id"),
    "…the same place notify-worker.js render() sends rsvp");
  ok(CadOrg._notif.link({ type: "something_new", payload: {} }) === "home.html",
    "an unknown type still lands somewhere real");
}

/* ── which links are same-document, and which are real navigations ────── */
{
  const same = CadOrg._notif.samePage;
  at("feed.html");
  ok(same("feed.html#post-p1") === true,
    "a link to this page's own fragment is recognised as same-document");
  ok(same("home.html") === false, "a link to another page is not");
  ok(same("event.html?id=e1") === false, "…nor is another page with a query");
  at("feed.html", "?group=g1");
  ok(same("feed.html#post-p1") === false,
    "dropping a query string is a real navigation, not a fragment change");
  at("event.html", "?id=e1");
  ok(same("event.html?id=e1") === true, "the same page with the same query is same-document");
  ok(same("event.html?id=e2") === false, "…a different query is not");
  at("home.html");
}

/* ── the channels the schema accepts, and the ones this UI claims ─────── */
{
  const dir = path.join(ROOT, "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const sql = files.map((f) => read(path.join("supabase", "migrations", f))).join("\n");
  const offered = CadOrg._notif.channels();
  const widened = /check \(channel in \('inapp'/.test(sql);
  // #2: a control nothing consumes is a lie told politely. Every enqueue
  // path gates itself on should_notify(member, scope, id, channel, prio) —
  // whichever channels those calls name are the channels a member can set.
  const asked = new Set((sql.match(/should_notify\([^)]*\)/g) || [])
    .map((c) => (/'(inapp|push|email)'/.exec(c) || [])[1]).filter(Boolean));
  ok(asked.has("inapp") && asked.has("push"),
    "the migrations ask should_notify() about in-app and push" +
    (widened ? " (and a migration widens the column to accept 'inapp')" : ""));
  ok(!asked.has("email"),
    "…and never about email, on any migration — no member email is gated by a preference");
  ["inapp", "push", "email"].forEach((ch) => ok((offered.indexOf(ch) >= 0) === asked.has(ch),
    `settings offers a ${ch} level exactly when an enqueue path consults one ` +
    `(offered: ${offered.indexOf(ch) >= 0}, consulted: ${asked.has(ch)})`));
}

async function main() {
  /* ── sign the fake browser into a workspace ─────────────────────────── */
  const MEMBER = {
    id: "mem-1", role_id: "role-1", status: "active",
    org: { id: "org-1", name: "Test HS", plan: "ensemble", status: "active" },
    role: { id: "role-1", name: "Member", permissions: [] },
  };
  const UNREAD = () => [
    { id: "n1", type: "ack_post", priority: "urgent", created_at: "2026-08-18T12:00:00Z", payload: { post_id: "p1", title: "Bus at 6" } },
    { id: "n2", type: "rsvp", priority: "normal", created_at: "2026-08-18T11:00:00Z", payload: { event_id: "e1", title: "Home show" } },
    { id: "n3", type: "ack_post", priority: "normal", created_at: "2026-08-17T11:00:00Z", payload: { post_id: "p2", title: "Uniform check" } },
  ];
  let unread = UNREAD();
  const LIVE = (c) => {
    if (c.path.startsWith("org_members?")) return { status: 200, body: [MEMBER] };
    if (c.path.startsWith("org_notifications") && c.method === "GET") return { status: 200, body: unread };
    if (c.path.startsWith("org_notifications")) return { status: 204 };
    if (c.path.startsWith("org_notification_prefs") && c.method === "GET") {
      return { status: 200, body: [{ channel: "push", level: "important" }] };
    }
    return { status: 201 };
  };
  handler = LIVE;
  await CadOrg.reload();
  CadOrg.select("org-1");
  ok(CadOrg.current() && CadOrg.current().id === "org-1", "harness: a workspace is selected");

  /* ── mounting the shell paints the bell and counts what is unread ───── */
  els.ensShell = node("div");
  els.ensBell = node("button");
  els.ensBellN = node("span");
  els.ensOrgPick = node("button");
  els.ensMoreBtn = node("button");
  els.ensPrefMsg = node("p");     // the settings sheet's status line, looked up by id
  CadOrg.mountShell("home");
  const shell = els.ensShell.innerHTML;
  ok(/id="ensBell"/.test(shell) && /id="ensBellN"/.test(shell),
    "the mounted shell contains the bell and its badge");
  ok(/aria-haspopup="dialog"/.test(shell.slice(shell.indexOf("ens-bell"))),
    "the bell announces the sheet it opens");
  await CadOrg._notif.load();
  ok(CadOrg.notifUnread() === 3, "the badge counts the caller's unread in-app rows");
  ok(els.ensBellN.hidden === false && els.ensBellN.textContent === "3", "the badge paints that count");
  ok(/3 unread/.test(els.ensBell.attrs["aria-label"] || ""), "the count is announced, not just drawn");
  ok(last().method === "GET" && last().path === CadOrg._notif.query("org-1", 30),
    "load() issues exactly the audited query");

  CadOrg._notif.setUnread(12);
  ok(els.ensBellN.textContent === "9+", "a big count stays badge-sized");
  CadOrg._notif.setUnread(0);
  ok(els.ensBellN.hidden === true, "zero unread hides the badge entirely");
  await CadOrg._notif.load();

  /* ── every sheet is one dialog, trapped and Escapable ────────────────
     Four openers, one sheet system: the workspace switcher, the phone's
     More sheet, the notification reader and its settings. Driven, not
     grepped — Escape has to actually take each one down and hand focus
     back to whatever opened it. */
  for (const [name, label, open] of [
    ["switcher", "Your workspaces", () => els.ensOrgPick.fire("click", {})],
    ["More", "More sections", () => els.ensMoreBtn.fire("click", {})],
    ["notifications", "Notifications", () => CadOrg.openNotifications()],
    ["settings", "Notification settings", () => CadOrg.openNotifPrefs()],
  ]) {
    const opener = node("button");
    document.activeElement = opener;
    open();
    await settle();
    const s = lastSheet();
    ok(!!s && s.attrs["aria-label"] === label && s.attrs.role === "dialog" &&
       s.attrs["aria-modal"] === "true",
      `the ${name} sheet is one ens-sheet dialog, like every other`);
    escape_();
    ok(!!s && s.removed === true, `…Escape closes the ${name} sheet`);
    ok(opener.focused > 0, `…and focus goes back to what opened it (${name})`);
    document.activeElement = null;
  }
  ok(keys.length === 0, "a closed sheet leaves no keydown handler behind");

  /* ── the phone's More sheet reaches notification settings ───────────── */
  els.ensMoreBtn.fire("click", {});
  await settle();
  const more = lastSheet();
  more.fire("click", { target: { closest: (sel) => (sel === "#ensMorePrefs" ? {} : null) } });
  await settle();
  ok(more.removed === true && lastSheet().attrs["aria-label"] === "Notification settings",
    "'Notification settings' in the More sheet opens the settings sheet");
  escape_();

  /* ── opening one writes read_at and NOTHING else ────────────────────── */
  await CadOrg._notif.load();
  await CadOrg._notif.markRead("n1");
  const patch = last();
  ok(patch.method === "PATCH" && patch.path === "org_notifications?id=eq.n1",
    "opening a notification PATCHes that one row");
  ok(Object.keys(patch.body).length === 1 && Object.keys(patch.body)[0] === "read_at",
    "read_at is the ONLY field written (guard_notification_update allows nothing else)");
  ok(typeof patch.body.read_at === "string" && !isNaN(Date.parse(patch.body.read_at)),
    "read_at is written as a timestamp");
  ok(!("status" in patch.body) && !("payload" in patch.body) && !("attempts" in patch.body),
    "the recipient never touches status, payload or attempts");
  ok(CadOrg.notifUnread() === 2, "the count drops by one");

  /* ── #3: the badge is reconciled with the list, not decremented blind ─
     Three unread; dismissing the same row twice must move the number once.
     A blind `count - 1` reads 1 here while two are genuinely unread. */
  await CadOrg._notif.markRead("n1");
  ok(CadOrg.notifUnread() === 2,
    "dismissing the same row twice moves the badge once, not twice");
  ok((CadOrg._notif.state.rows || []).length === 2,
    "…and the list and the badge still agree");
  await CadOrg._notif.markRead("no-such-row");
  ok(CadOrg.notifUnread() === 2, "dismissing a row that was never on the list leaves the badge alone");
  await CadOrg._notif.markRead("n2");
  await CadOrg._notif.markRead("n3");
  ok(CadOrg.notifUnread() === 0, "dismissing everything reaches zero");
  await CadOrg._notif.markRead("n3");        // already gone: a double tap, a stale sheet
  ok(CadOrg.notifUnread() === 0, "dismissing an already-read row keeps the count at zero");
  ok(CadOrg._notif.setUnread(-5) === 0, "a negative count floors at zero");
  ok(CadOrg._notif.setUnread(NaN) === 0, "a nonsense count floors at zero");
  ok(CadOrg._notif.setUnread(4) === 4, "a real count still counts");

  /* ── #1: tapping a row closes the sheet and actually goes somewhere ───
     The member an acknowledgment-required announcement is aimed at is
     exactly the person already sitting on feed.html, where
     "feed.html#post-p1" is a same-document fragment change: no unload, no
     re-render, and feed.html only reads the hash from inside render(). */
  unread = UNREAD();
  {
    const loc = at("feed.html");
    CadOrg.openNotifications();
    await settle();
    const sheet = sheetNamed("Notifications");
    const href = hrefOf(sheet.innerHTML, "n1");
    ok(href === "feed.html#post-p1", "the sheet renders the ack_post row's deep link");
    const mark0 = calls.length;
    const prevented = tapRow(sheet, "n1", href);
    await settle();
    ok(prevented() === 1, "the row's own navigation is cancelled so read_at is written first");
    const patched = calls.slice(mark0)
      .filter((c) => c.path === "org_notifications?id=eq.n1" && c.method === "PATCH");
    ok(patched.length === 1, "tapping a row marks exactly that row read");
    ok(sheet.removed === true,
      "tapping a row closes the sheet — it must not hang over the page it just dismissed");
    ok(loc.hash === "#post-p1", "…the deep link's fragment is put in place");
    ok(loc.reloads === 1,
      "…and a same-document link reloads, because nothing here listens for hashchange");
    ok(loc.href === "", "…no href assignment, which would have been a silent no-op");
    ok(CadOrg.notifUnread() === 2, "…and the badge drops to what is still unread");
  }

  /* the ordinary case still works the ordinary way */
  {
    const loc = at("home.html");
    unread = UNREAD();
    CadOrg.openNotifications();
    await settle();
    const sheet = sheetNamed("Notifications");
    tapRow(sheet, "n2", hrefOf(sheet.innerHTML, "n2"));
    await settle();
    ok(loc.href === "event.html?id=e1", "from another page the link is followed normally");
    ok(loc.reloads === 0, "…without a pointless reload");
    ok(sheet.removed === true, "…and the sheet still closes");
  }

  /* a failed dismissal must never strand someone on the sheet */
  {
    const loc = at("home.html");
    unread = UNREAD();
    CadOrg.openNotifications();
    await settle();
    const sheet = sheetNamed("Notifications");
    handler = (c) => (c.method === "PATCH"
      ? { status: 500, body: { message: "boom" } } : LIVE(c));
    tapRow(sheet, "n1", hrefOf(sheet.innerHTML, "n1"));
    await settle();
    ok(loc.href === "feed.html#post-p1" && sheet.removed === true,
      "a failed PATCH still closes the sheet and still follows the deep link");
    handler = LIVE;
  }

  /* ── #4: a failed "Mark all read" says so ───────────────────────────── */
  {
    at("home.html");
    unread = UNREAD();
    CadOrg.openNotifications();
    await settle();
    const sheet = sheetNamed("Notifications");
    ok(/id="ensNotifMsg"/.test(sheet.innerHTML) && /role="status"/.test(sheet.innerHTML),
      "the notification sheet has a status line at all");
    handler = (c) => (c.method === "PATCH"
      ? { status: 503, body: { message: "upstream down" } } : LIVE(c));
    tapButton(sheet, "ensNotifAll");
    await settle();
    ok(/Couldn't mark those read/.test(text(sheet.innerHTML)),
      "a failed 'Mark all read' tells the member instead of redrawing in silence");
    ok(/data-notif="n1"/.test(sheet.innerHTML),
      "…and the rows it could not clear are still listed");
    handler = LIVE;
    unread = [];
    tapButton(sheet, "ensNotifAll");
    await settle();
    ok(!/Couldn't mark those read/.test(text(sheet.innerHTML)),
      "a successful retry clears the message");
    ok(/all caught up/.test(sheet.innerHTML), "…and the sheet is empty");
    escape_();
  }

  /* ── mark-all writes the same one field, over the same filters ──────── */
  unread = [];
  await CadOrg._notif.markAllRead();
  const all = last();
  ok(all.method === "PATCH" && all.path === CadOrg._notif.markAllPath("org-1"),
    "mark-all PATCHes exactly the unread in-app rows of this workspace");
  ok(/channel=eq\.inapp/.test(all.path) && /read_at=is\.null/.test(all.path),
    "mark-all cannot reach another channel or an already-read row");
  ok(Object.keys(all.body).length === 1 && Object.keys(all.body)[0] === "read_at",
    "mark-all writes read_at and nothing else");
  ok(CadOrg.notifUnread() === 0, "mark-all clears the badge");

  /* ── a failed load never invents a number ───────────────────────────── */
  handler = (c) => (c.path.startsWith("org_notifications")
    ? { status: 404, body: { message: 'relation "public.org_notifications" does not exist' } }
    : { status: 200, body: [] });
  CadOrg._notif.setUnread(7);
  await CadOrg._notif.load();
  ok(CadOrg.notifUnread() === 0, "an unreachable queue shows zero, not a stale count");
  ok(CadOrg._notif.state.err === true, "…and the sheet knows to say so");

  /* ── preferences: values 0006's CHECK constraints accept ────────────── */
  const LEVELS = ["all", "important", "urgent", "none"];
  handler = () => ({ status: 201 });
  await CadOrg._notif.savePref("push", "none");
  const pref = last();
  ok(pref.method === "POST" && pref.path === "org_notification_prefs",
    "a preference is an upsert into org_notification_prefs");
  ok(pref.headers.Prefer === "resolution=merge-duplicates",
    "…merging on its (member, scope, scope_id, channel) primary key");
  ok(pref.body.member_id === "mem-1" && pref.body.scope_id === "org-1",
    "…for this member, in this workspace");
  ok(pref.body.scope === "org",
    "scope is 'org' — the scope every enqueue path looks a preference up by");
  ok(LEVELS.includes(pref.body.level), "level is a value the 0006 CHECK accepts");
  ok(Object.keys(pref.body).sort().join(",") === "channel,level,member_id,scope,scope_id",
    "the preference row carries no extra columns");

  /* ── a channel the database refuses degrades, it does not throw ─────── */
  const CHECK_ERR = {
    status: 400,
    body: { code: "23514", message: 'new row for relation "org_notification_prefs" violates ' +
      'check constraint "org_notification_prefs_channel_check"' },
  };
  handler = (c) => (c.body && c.body.channel === "inapp" ? CHECK_ERR : { status: 201 });
  let caught = null;
  try { await CadOrg._notif.savePref("inapp", "none"); } catch (e) { caught = e; }
  ok(!!caught && CadOrg._notif.rejected(caught),
    "a CHECK-constraint refusal is recognised as 'this database doesn't have that channel'");
  ok(!CadOrg._notif.rejected(new Error("network down")),
    "a plain failure is not mistaken for a constraint refusal");
  ok(!CadOrg._notif.rejected({ status: 403, body: { code: "42501", message: "permission denied" } }),
    "an RLS refusal is not mistaken for a constraint refusal");

  /* ── and the settings sheet actually folds that channel away ────────── */
  handler = (c) => {
    if (c.method === "GET") return { status: 200, body: [{ channel: "push", level: "important" }] };
    return c.body && c.body.channel === "inapp" ? CHECK_ERR : { status: 201 };
  };
  CadOrg.openNotifPrefs();
  await settle();
  const sheet = sheetNamed("Notification settings");
  ok(/data-ch="inapp"/.test(sheet.innerHTML),
    "the settings sheet renders the in-app row before the database has been asked");
  ok(/data-ch="push"/.test(sheet.innerHTML), "settings offers the push level");
  ok(!/data-ch="email"/.test(sheet.innerHTML),
    "#2 settings offers no Email control, because no delivery path reads one");
  ok(/no email about announcements/.test(sheet.innerHTML) &&
     /invitation/.test(sheet.innerHTML),
    "#2 …and says so plainly, including which email the workspace does send");
  ok(/RSVP requests are in-app/.test(sheet.innerHTML),
    "#2 the push row admits RSVPs are never pushed");
  ok(LEVELS.every((l) => sheet.innerHTML.includes('value="' + l + '"')), "settings offers all four levels");
  ok(/value="important" selected/.test(sheet.innerHTML), "settings shows the level already saved");
  ok(/Mute this workspace/.test(sheet.innerHTML), "'mute this workspace' is a real button");
  ok(/[Uu]rgent announcements always get through/.test(sheet.innerHTML),
    "settings tells the truth about urgent announcements");

  /* muting says what it muted, and claims nothing about email */
  const before = calls.length;
  tapButton(sheet, "ensPrefMute");
  await settle(8);
  ok(/Muted every channel above/.test(els.ensPrefMsg.textContent),
    "#2 'Mute this workspace' reports what it actually muted");
  ok(!/email/i.test(els.ensPrefMsg.textContent),
    "#2 …and never claims to have silenced email");
  const muted = calls.slice(before)
    .filter((c) => c.path === "org_notification_prefs" && c.body && c.body.level === "none");
  ok(muted.length > 0 && muted.every((c) => c.body.channel !== "email"),
    "#2 muting writes no email preference row at all");

  /* one channel at a time names the channel it muted */
  sheet.fire("change", {
    target: { getAttribute: (k) => (k === "data-ch" ? "push" : null), value: "none" },
  });
  await settle();
  ok(/Push notifications/.test(els.ensPrefMsg.textContent) &&
     /muted/i.test(els.ensPrefMsg.textContent),
    "muting one channel says which channel, not 'everything'");
  ok(/[Uu]rgent announcements still reach you/.test(els.ensPrefMsg.textContent),
    "…and repeats the one promise the workspace keeps");

  CadOrg.openNotifPrefs();
  await settle();
  const s2 = sheetNamed("Notification settings");
  s2.fire("change", {
    target: { getAttribute: (k) => (k === "data-ch" ? "inapp" : null), value: "none" },
  });
  await settle();
  ok(!/data-ch="inapp"/.test(s2.innerHTML),
    "a refused channel folds away instead of throwing at the member");
  ok(/data-ch="push"/.test(s2.innerHTML),
    "…and the channels the database does accept stay usable");
  escape_();
}

main().then(report, (err) => {
  fail.push("harness threw: " + (err && err.stack || err));
  report();
});

function report() {
  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) {
    console.log(`FAIL ${fail.length}`);
    fail.forEach((m) => console.log("  FAIL " + m));
    process.exit(1);
  }
}
