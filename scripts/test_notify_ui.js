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
 *   • the unread count cannot go negative, however many times a row is
 *     dismissed or a load fails;
 *   • the preference surface writes values 0006's CHECK constraints accept,
 *     and folds a channel away with a note (rather than throwing) when the
 *     database refuses it — the case for 'inapp' until a migration widens
 *     org_notification_prefs.channel.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const tick = () => new Promise((r) => setTimeout(r, 0));

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
    attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); },
    appendChild() {}, remove() {}, focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
global.document = {
  body: { appendChild() {} },
  head: { appendChild() {} },
  activeElement: null,
  getElementById: (id) => els[id] || null,
  createElement: (tag) => { const n = node(tag); created.push(n); return n; },
  addEventListener() {}, removeEventListener() {},
};
global.location = { href: "" };

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

/* ── the channels offered vs. the channels the schema accepts ─────────── */
{
  const dir = path.join(ROOT, "supabase", "migrations");
  const sql = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => read(path.join("supabase", "migrations", f))).join("\n");
  const src = read("docs/ensemble/core.js");
  const widened = /check \(channel in \('inapp'/.test(sql);
  ok(/\["push", /.test(src) && /\["email", /.test(src),
    "settings offers the two channels 0006's CHECK has always accepted");
  ok(/\["inapp", /.test(src), "settings offers the in-app channel" +
    (widened ? " a migration widens the column to accept" : " optimistically"));
  ok(/channelRejected/.test(src) && /prefsOff\[ch\] = true/.test(src),
    "…and folds it away on a database whose CHECK has not been widened");
  ok(/scope: "org"/.test(src) && !/scope: "(announcement|event)"/.test(src),
    "preferences are written at the scope should_notify() looks them up by");
}

/* ── the shell carries the bell, and one sheet system carries the rest ── */
{
  const src = read("docs/ensemble/core.js");
  ok(/id="ensBell"/.test(src) && /ens-bell-n/.test(src), "shellHtml renders the bell and its badge");
  ok(/aria-haspopup="dialog"/.test(src.slice(src.indexOf("ens-bell"))), "the bell announces its sheet");
  ok((src.match(/trapSheet\(wrap\)/g) || []).length === 4,
    "every sheet (switcher, More, notifications, settings) goes through the one focus trap");
  ok((src.match(/wrap\.className = "ens-sheet"/g) || []).length === 4,
    "no second modal system was invented");
  ok(/ensMorePrefs/.test(src), "the phone's More sheet reaches notification settings");
}

async function main() {
  /* ── sign the fake browser into a workspace ─────────────────────────── */
  const MEMBER = {
    id: "mem-1", role_id: "role-1", status: "active",
    org: { id: "org-1", name: "Test HS", plan: "ensemble", status: "active" },
    role: { id: "role-1", name: "Member", permissions: [] },
  };
  let unread = [
    { id: "n1", type: "ack_post", priority: "urgent", created_at: "2026-08-18T12:00:00Z", payload: { post_id: "p1", title: "Bus at 6" } },
    { id: "n2", type: "rsvp", priority: "normal", created_at: "2026-08-18T11:00:00Z", payload: { event_id: "e1", title: "Home show" } },
    { id: "n3", type: "ack_post", priority: "normal", created_at: "2026-08-17T11:00:00Z", payload: { post_id: "p2", title: "Uniform check" } },
  ];
  handler = (c) => {
    if (c.path.startsWith("org_members?")) return { status: 200, body: [MEMBER] };
    if (c.path.startsWith("org_notifications") && c.method === "GET") return { status: 200, body: unread };
    if (c.path.startsWith("org_notifications")) return { status: 204 };
    if (c.path.startsWith("org_notification_prefs") && c.method === "GET") {
      return { status: 200, body: [{ channel: "email", level: "important" }] };
    }
    return { status: 201 };
  };
  await CadOrg.reload();
  CadOrg.select("org-1");
  ok(CadOrg.current() && CadOrg.current().id === "org-1", "harness: a workspace is selected");

  /* ── mounting the shell paints the bell and counts what is unread ───── */
  els.ensShell = node("div");
  els.ensBell = node("button");
  els.ensBellN = node("span");
  CadOrg.mountShell("home");
  ok(/id="ensBell"/.test(els.ensShell.innerHTML), "the mounted shell contains the bell");
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

  /* ── opening one writes read_at and NOTHING else ────────────────────── */
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

  /* ── the count cannot go negative ───────────────────────────────────── */
  await CadOrg._notif.markRead("n2");
  await CadOrg._notif.markRead("n3");
  ok(CadOrg.notifUnread() === 0, "dismissing everything reaches zero");
  await CadOrg._notif.markRead("n3");        // already gone: a double tap, a stale sheet
  ok(CadOrg.notifUnread() === 0, "dismissing an already-read row keeps the count at zero");
  ok(CadOrg._notif.setUnread(-5) === 0, "a negative count floors at zero");
  ok(CadOrg._notif.setUnread(NaN) === 0, "a nonsense count floors at zero");
  ok(CadOrg._notif.setUnread(4) === 4, "a real count still counts");

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
  const SCOPES = ["org", "group", "chat"];
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
  ok(SCOPES.includes(pref.body.scope), "scope is a value the 0006 CHECK accepts");
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
    if (c.method === "GET") return { status: 200, body: [{ channel: "email", level: "important" }] };
    return c.body && c.body.channel === "inapp" ? CHECK_ERR : { status: 201 };
  };
  CadOrg.openNotifPrefs();
  await tick();
  const sheet = created[created.length - 1].tag === "div"
    ? created[created.length - 1]
    : created.filter((n) => n.tag === "div").pop();
  ok(/data-ch="inapp"/.test(sheet.innerHTML),
    "the settings sheet renders the in-app row before the database has been asked");
  ok(/data-ch="push"/.test(sheet.innerHTML) && /data-ch="email"/.test(sheet.innerHTML),
    "settings offers push and email");
  ok(LEVELS.every((l) => sheet.innerHTML.includes('value="' + l + '"')), "settings offers all four levels");
  ok(/value="important" selected/.test(sheet.innerHTML), "settings shows the level already saved");
  ok(/Mute this workspace/.test(sheet.innerHTML), "'mute this workspace' is a real button");
  ok(/[Uu]rgent announcements always get through/.test(sheet.innerHTML),
    "settings tells the truth about urgent announcements");

  sheet.fire("change", {
    target: { getAttribute: (k) => (k === "data-ch" ? "inapp" : null), value: "none" },
  });
  await tick(); await tick();
  ok(!/data-ch="inapp"/.test(sheet.innerHTML),
    "a refused channel folds away instead of throwing at the member");
  ok(/data-ch="push"/.test(sheet.innerHTML) && /data-ch="email"/.test(sheet.innerHTML),
    "…and the channels the database does accept stay usable");
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
