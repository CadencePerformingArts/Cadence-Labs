#!/usr/bin/env node
/* Tests for the Stripe billing domain with SIGNED fixtures — no network,
 * no Stripe account, no secrets beyond a made-up test string.
 *
 *   node scripts/test_stripe_core.js
 *
 * Three layers, all behavioural:
 *
 *   1. the state machine — signature verification (accept/reject/replay
 *      window), the claim protocol, and every transition: checkout activates
 *      the plan, payment failure opens a grace period, renewal clears it,
 *      cancellation goes read-only (never deletes), unknown customers and
 *      prices are ignored safely, and every date a handler STORES comes from
 *      the event's own clock so re-applying an event is a no-op.
 *   2. the real claim ledger from _shared/stripe-core.js, driven against a
 *      stub PostgREST: the `pending:` prefix, the 409 read-back, the
 *      stale-claim arithmetic and the `type=like.pending:*` release filter
 *      are the riskiest lines in the webhook, so they are exercised rather
 *      than imitated.
 *   3. the billing page's checkout gate, RENDERED — billing.html's own
 *      script is executed on top of the real core.js for all eight
 *      organization statuses, and the button it produces is read back out of
 *      the HTML.
 */
import { verifyStripeSignature, signStripePayload, applyStripeEvent, planFromPrice,
         makeEventLedger, statusForResult, PENDING, STALE_CLAIM_MS }
  from "../supabase/functions/_shared/stripe-core.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const SECRET = "whsec_test_fixture_secret";
const PRICES = { ensemble: "price_ens", pro: "price_pro", program: "price_prog" };
const settle = async (n) => { for (let i = 0; i < (n || 4); i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeDb() {
  const seen = new Set(), orgs = {}, logs = [];
  return {
    orgs, logs,
    seed(id, fields) { orgs[id] = { id, plan: null, status: "trialing", quota: 5, ...fields }; },
    async recordEvent(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    async orgByCustomer(cus) {
      return Object.values(orgs).find((o) => o.stripe_customer_id === cus) ?? null;
    },
    async update(orgId, fields) {
      const o = orgs[orgId]; if (!o) throw new Error("no org " + orgId);
      const f = { ...fields };
      if ("storage_quota_bytes_min" in f) {
        o.quota = Math.max(o.quota, f.storage_quota_bytes_min); delete f.storage_quota_bytes_min;
      }
      Object.assign(o, f);
    },
    async log(action, orgId, detail) { logs.push({ action, orgId, detail }); },
  };
}

/* ── a PostgREST small enough to fit in a test ────────────────────────────
 * Only what stripe_events needs, but honestly: a primary key that answers
 * 409, the read-back the ledger selects with, and PATCH/DELETE that apply
 * the SAME filters the ledger sends — including `type=like.pending:*`, so a
 * release that dropped that filter really would eat an applied row here. */
function stubRest() {
  const rows = new Map(), calls = [];
  const url = "https://stub.supabase.test";
  let clock = Date.parse("2026-08-18T12:00:00.000Z");
  let failReads = 0, forceConflict = 0;

  const reply = (status, body) => ({
    ok: status < 400, status,
    json: async () => body,
    text: async () => (body === undefined || body === null ? "" : JSON.stringify(body)),
  });
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function matches(row, filters) {
    return filters.every(([col, op, val]) => {
      if (op === "eq") return String(row[col]) === val;
      if (op === "like") {   // PostgREST spells the wildcard '*'
        return new RegExp("^" + val.split("*").map(rx).join(".*") + "$").test(String(row[col]));
      }
      throw new Error("stub PostgREST: unsupported operator " + op);
    });
  }

  async function fetchStub(input, init) {
    const o = init || {};
    const u = new URL(String(input));
    const table = u.pathname.replace(/^\/rest\/v1\//, "");
    const method = o.method || "GET";
    const body = o.body ? JSON.parse(o.body) : null;
    calls.push({ table, method, query: u.search, body });
    if (!/^Bearer /.test((o.headers || {}).Authorization || "")) return reply(401, { message: "no key" });
    if (table !== "stripe_events") return reply(404, { message: "stub: unknown table " + table });

    const filters = [];
    for (const [k, v] of u.searchParams) {
      if (k === "select") continue;
      const i = v.indexOf(".");
      filters.push([k, v.slice(0, i), v.slice(i + 1)]);
    }
    const hit = () => [...rows.values()].filter((r) => matches(r, filters));

    if (method === "POST") {
      if (forceConflict > 0) { forceConflict--; return reply(409, { message: "forced conflict" }); }
      if (rows.has(body.id)) return reply(409, { code: "23505", message: "duplicate key value" });
      rows.set(body.id, { received_at: new Date(clock).toISOString(), ...body });
      return reply(201, null);
    }
    if (method === "GET") {
      if (failReads > 0) { failReads--; return reply(500, { message: "read exploded" }); }
      return reply(200, hit());
    }
    if (method === "PATCH") { hit().forEach((r) => Object.assign(r, body)); return reply(204, null); }
    if (method === "DELETE") { hit().forEach((r) => rows.delete(r.id)); return reply(204, null); }
    return reply(405, { message: method });
  }

  return {
    url, calls, rows, fetch: fetchStub,
    now: () => clock,
    advance(ms) { clock += ms; },
    row: (id) => rows.get(id) || null,
    breakNextRead() { failReads++; },
    conflictNext() { forceConflict++; },
  };
}

/* ── a browser small enough to render billing.html ────────────────────────
 * core.js reads bare globals as well as window.*, so window IS the global
 * object here, exactly as scripts/test_notify_ui.js does it. */
global.window = global;
global.CAD_SUPABASE = { url: "https://db.test", publishableKey: "pk_test" };
global.fetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
global.localStorage = { length: 0, key: () => null, getItem: () => null, setItem() {} };
global.location = { pathname: "/ensemble/billing.html", search: "", hash: "", href: "" };
const bareNode = () => ({
  innerHTML: "", textContent: "", className: "", style: {}, dataset: {},
  setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {},
  querySelector: () => null, querySelectorAll: () => [],
});
let billingMain = bareNode();
global.document = {
  body: { appendChild() {} }, head: { appendChild() {} },
  getElementById: (id) => (id === "ensMain" ? billingMain : null),
  createElement: () => bareNode(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
};
global.alert = () => {};

new Function(read("docs/ensemble/core.js"))();
const CadOrg = global.CadOrg;

/* billing.html's own page script, lifted out of the page and run for real */
const BILLING_SRC = (() => {
  const blocks = read("docs/ensemble/billing.html").match(/<script>[\s\S]*?<\/script>/g) || [];
  const src = blocks
    .map((b) => b.replace(/^<script>/, "").replace(/<\/script>$/, ""))
    .filter((s) => s.includes("function planCard("))[0];
  if (!src) throw new Error("billing.html: no inline script defining planCard()");
  return src;
})();

async function renderBilling(org, opts) {
  const o = opts || {};
  billingMain = bareNode();
  CadOrg.start = async () => org;
  CadOrg.rest = async () => [];
  CadOrg.log = async () => {};
  CadOrg.can = () => o.canBill !== false;          // the permission, not the plan
  global.CadPeople = {
    softCount: async () => 12,
    fmtDate: (d) => (d ? String(d).slice(0, 10) : "—"),
    bytes: (n) => Number(n) + " B",
    money: () => "$0.00",
    toast() {},
  };
  global.CadAccount = { user: () => ({ id: "u1" }) };
  new Function(BILLING_SRC)();
  await settle(6);
  return billingMain.innerHTML;
}

(async () => {
  /* ── signature verification ─────────────────────────────────────────── */
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const nowSec = 1_700_000_000;
  const header = await signStripePayload(payload, SECRET, nowSec);
  const now = () => nowSec * 1000;

  ok((await verifyStripeSignature({ payload, header, secret: SECRET, now })).ok,
    "valid signature accepted");
  ok(!(await verifyStripeSignature({ payload: payload + "x", header, secret: SECRET, now })).ok,
    "tampered payload rejected");
  ok(!(await verifyStripeSignature({ payload, header, secret: "whsec_other", now })).ok,
    "wrong secret rejected");
  ok(!(await verifyStripeSignature({ payload, header, secret: SECRET,
      now: () => (nowSec + 3600) * 1000 })).ok,
    "stale timestamp rejected (replay window)");
  ok(!(await verifyStripeSignature({ payload, header: "v1=deadbeef", secret: SECRET, now })).ok,
    "malformed header rejected");

  /* ── price mapping ──────────────────────────────────────────────────── */
  ok(planFromPrice(PRICES, "price_pro") === "pro", "price maps to plan");
  ok(planFromPrice(PRICES, "price_unknown") === null, "unknown price maps to null");

  /* ── the state machine ──────────────────────────────────────────────── */
  const db = fakeDb();
  db.seed("org1", {});

  // checkout completes -> plan active, customer recorded, quota floored
  let r = await applyStripeEvent({
    id: "evt_co1", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "paid", customer: "cus_1",
      metadata: { org_id: "org1", plan: "ensemble", price_id: "price_ens" } } },
  }, db, PRICES);
  ok(db.orgs.org1.plan === "ensemble" && db.orgs.org1.status === "active",
    "checkout.completed activates the plan");
  ok(db.orgs.org1.stripe_customer_id === "cus_1", "customer id recorded");
  ok(db.orgs.org1.quota === 10737418240, "storage quota floored to the plan's");
  ok(db.orgs.org1.renews_at === new Date((nowSec + 365 * 86400) * 1000).toISOString(),
    "renews_at is one year from the EVENT's clock, not from now()");

  // duplicate delivery is a no-op
  db.orgs.org1.status = "sentinel";
  r = await applyStripeEvent({
    id: "evt_co1", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "paid", customer: "cus_1",
      metadata: { org_id: "org1", plan: "ensemble", price_id: "price_ens" } } },
  }, db, PRICES);
  ok(r.action === "duplicate" && db.orgs.org1.status === "sentinel",
    "duplicate event id is a no-op");
  ok(statusForResult(r) === 200, "…and an applied duplicate is acknowledged 200");
  db.orgs.org1.status = "active";

  // unpaid checkout grants nothing
  db.seed("org2", {});
  await applyStripeEvent({
    id: "evt_co2", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "unpaid", customer: "cus_2",
      metadata: { org_id: "org2", plan: "pro", price_id: "price_pro" } } },
  }, db, PRICES);
  ok(db.orgs.org2.plan === null, "unpaid checkout grants nothing");

  // payment failure -> past_due with a grace window measured from the EVENT
  const failedAt = nowSec + 5 * 86400;
  const graceFor = (created) => new Date((created + 14 * 86400) * 1000).toISOString();
  await applyStripeEvent({
    id: "evt_pf1", type: "invoice.payment_failed", created: failedAt,
    data: { object: { customer: "cus_1" } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "past_due" && db.orgs.org1.grace_ends_at,
    "payment failure opens a grace period");
  ok(db.orgs.org1.grace_ends_at === graceFor(failedAt),
    "grace_ends_at is 14 days after the event, not 14 days after the wall clock");

  // …so re-applying that same event (a released or stale claim, or Stripe's
  // "Resend" button) writes the identical deadline instead of walking it on
  {
    const again = fakeDb();
    again.seed("orgG", { stripe_customer_id: "cus_g" });
    const evt = { id: "evt_pfG", type: "invoice.payment_failed", created: failedAt,
      data: { object: { customer: "cus_g" } } };
    await applyStripeEvent(evt, again, PRICES);
    const first = again.orgs.orgG.grace_ends_at;
    again.orgs.orgG.grace_ends_at = null;
    await applyStripeEvent({ ...evt, id: "evt_pfG2" }, again, PRICES);
    ok(first === graceFor(failedAt) && again.orgs.orgG.grace_ends_at === first,
      "re-applying invoice.payment_failed is byte-identical (absolute state, not an increment)");
  }

  // and nothing in the handlers may reach for the wall clock to build a value
  // (comments stripped: the code is the claim, the prose about it is not)
  {
    const core = read("supabase/functions/_shared/stripe-core.js");
    const i = core.indexOf("async function runHandler(");
    const code = core.slice(i).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    ok(i > 0 && !/Date\.now\s*\(/.test(code),
      "no handler calls Date.now() — the header's absolute-state promise is true");
  }

  // renewal clears it
  await applyStripeEvent({
    id: "evt_ip1", type: "invoice.paid", created: nowSec,
    data: { object: { customer: "cus_1",
      lines: { data: [{ period: { end: nowSec + 366 * 86400 } }] } } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "active" && db.orgs.org1.grace_ends_at === null,
    "invoice.paid restores active and clears grace");

  // plan change via subscription.updated
  await applyStripeEvent({
    id: "evt_su1", type: "customer.subscription.updated", created: nowSec,
    data: { object: { customer: "cus_1", status: "active",
      current_period_end: nowSec + 400 * 86400,
      items: { data: [{ price: { id: "price_prog" } }] } } },
  }, db, PRICES);
  ok(db.orgs.org1.plan === "program" && db.orgs.org1.quota === 107374182400,
    "subscription.updated upgrades the plan and quota floor");

  // cancellation -> read-only, never deleted
  await applyStripeEvent({
    id: "evt_sd1", type: "customer.subscription.deleted", created: nowSec,
    data: { object: { customer: "cus_1" } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "read_only" && db.orgs.org1.plan === "program",
    "cancellation goes read-only and keeps history");

  // unknown customer is ignored safely
  r = await applyStripeEvent({
    id: "evt_x1", type: "invoice.paid", created: nowSec,
    data: { object: { customer: "cus_nobody" } },
  }, db, PRICES);
  ok(r.action === "no such customer", "unknown customer ignored safely");

  /* ── the claim ledger: a failed application must not eat the event id ──
   * ledgerDb models what the webhook's db does against stripe_events; the
   * REAL implementation gets its own section below. */
  function ledgerDb() {
    const d = fakeDb(), ledger = new Map();
    d.ledger = ledger;
    d.recordEvent = async (id, type) => {
      if (ledger.has(id)) return String(ledger.get(id)).startsWith("pending:") ? "in_flight" : false;
      ledger.set(id, "pending:" + type); return true;
    };
    d.markApplied = async (id, type) => { ledger.set(id, type); };
    d.releaseEvent = async (id) => {
      if (String(ledger.get(id)).startsWith("pending:")) ledger.delete(id);
    };
    return d;
  }

  const paid = {
    id: "evt_co3", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "paid", customer: "cus_3",
      metadata: { org_id: "org3", plan: "pro", price_id: "price_pro" } } },
  };

  const ldb = ledgerDb();
  ldb.seed("org3", {});
  const realUpdate = ldb.update;
  let boom = true;
  ldb.update = async (orgId, fields) => {
    if (boom) { boom = false; throw new Error("transient 503"); }
    return realUpdate(orgId, fields);
  };

  let threw = false;
  try { await applyStripeEvent(paid, ldb, PRICES); } catch (e) { threw = true; }
  ok(threw && ldb.orgs.org3.plan === null, "a failing handler throws and grants nothing");
  ok(!ldb.ledger.has("evt_co3"), "a failed application releases the event id");

  // …so Stripe's retry of that same event is applied, not swallowed
  r = await applyStripeEvent(paid, ldb, PRICES);
  ok(ldb.orgs.org3.plan === "pro" && ldb.orgs.org3.status === "active",
    "the retry after a failure activates the paid plan");
  ok(ldb.ledger.get("evt_co3") === "checkout.session.completed",
    "a successful application marks the claim applied");

  // and a redelivery of an APPLIED event still changes nothing
  ldb.orgs.org3.status = "sentinel";
  r = await applyStripeEvent(paid, ldb, PRICES);
  ok(r.action === "duplicate" && ldb.orgs.org3.status === "sentinel",
    "redelivery after success stays a no-op");
  ok(ldb.ledger.get("evt_co3") === "checkout.session.completed",
    "the applied claim is never released by a redelivery");

  // a release that itself fails is reported loudly instead of losing a payment
  const sdb = ledgerDb();
  sdb.seed("org4", {});
  sdb.update = async () => { throw new Error("transient 503"); };
  sdb.releaseEvent = async () => { throw new Error("delete refused"); };
  let msg = "";
  try {
    await applyStripeEvent({ ...paid, id: "evt_co4",
      data: { object: { ...paid.data.object, customer: "cus_4",
        metadata: { ...paid.data.object.metadata, org_id: "org4" } } } }, sdb, PRICES);
  } catch (e) { msg = e.message; }
  ok(/transient 503/.test(msg) && /claim not released/.test(msg),
    "a release that fails names both errors in the 500 body");

  /* ── a claim that cannot be marked applied is NOT a 200 ────────────────
   * Swallowing this leaves a row reading `pending:<type>` while Stripe has
   * been told the event is delivered: unrecoverable, and mislabelled in the
   * ledger the runbook tells the owner to read. */
  {
    const mdb = ledgerDb();
    mdb.seed("org5", {});
    mdb.markApplied = async () => { throw new Error("PATCH refused"); };
    const evt = { ...paid, id: "evt_co5",
      data: { object: { ...paid.data.object, customer: "cus_5",
        metadata: { ...paid.data.object.metadata, org_id: "org5" } } } };
    let m = "";
    try { await applyStripeEvent(evt, mdb, PRICES); } catch (e) { m = e.message; }
    ok(/could not mark the claim applied/.test(m) && /evt_co5/.test(m),
      "a markApplied failure raises instead of answering 200");
    ok(mdb.orgs.org5.status === "active",
      "…the application itself still stands (the retry re-applies the same absolute state)");
    ok(String(mdb.ledger.get("evt_co5")).startsWith("pending:"),
      "…and the row is honestly still pending, so a later delivery revisits it");
  }

  /* ── an in-flight claim asks for a retry; only APPLIED earns a 2xx ───── */
  {
    const fdb = ledgerDb();
    fdb.seed("org6", {});
    const evt = { ...paid, id: "evt_co6",
      data: { object: { ...paid.data.object, customer: "cus_6",
        metadata: { ...paid.data.object.metadata, org_id: "org6" } } } };
    await fdb.recordEvent(evt.id, evt.type);          // an isolate claimed and died
    const out = await applyStripeEvent(evt, fdb, PRICES);
    ok(out.retry === true && out.action === "in flight",
      "a claim held by another delivery is reported as in-flight, not as a duplicate");
    ok(statusForResult(out) >= 400,
      "…and answers a non-2xx, so Stripe keeps retrying until the claim goes stale");
    ok(statusForResult({ handled: false, action: "duplicate" }) === 200 &&
       statusForResult({ handled: true, action: "activated pro" }) === 200,
      "…while applied and duplicate results answer 200");
    ok(fdb.orgs.org6.plan === null, "an in-flight event runs no handler");
  }

  /* ══ the REAL ledger against a stub PostgREST ═════════════════════════ */
  {
    const rest = stubRest();
    const led = makeEventLedger({ url: rest.url, key: "svc_key", fetch: rest.fetch, now: rest.now });

    ok((await led.recordEvent("evt_L1", "invoice.paid")) === true,
      "ledger: a fresh event id is claimed");
    ok(rest.row("evt_L1").type === PENDING + "invoice.paid",
      "ledger: the claim is written as `pending:<type>`, not as the bare type");

    ok((await led.recordEvent("evt_L1", "invoice.paid")) === "in_flight",
      "ledger: a second delivery inside the window is in-flight, NOT a duplicate");

    rest.advance(STALE_CLAIM_MS - 1000);
    ok((await led.recordEvent("evt_L1", "invoice.paid")) === "in_flight",
      "ledger: a claim one second short of stale is still in-flight");

    rest.advance(2000);
    const claimedAt = rest.row("evt_L1").received_at;
    ok((await led.recordEvent("evt_L1", "invoice.paid")) === true,
      "ledger: a claim older than STALE_CLAIM_MS is retaken");
    ok(rest.row("evt_L1").received_at !== claimedAt &&
       Date.parse(rest.row("evt_L1").received_at) === rest.now(),
      "ledger: retaking stamps received_at, so the next delivery waits the full window again");

    await led.markApplied("evt_L1", "invoice.paid");
    ok(rest.row("evt_L1").type === "invoice.paid",
      "ledger: marking applied rewrites the row to the bare type");
    ok((await led.recordEvent("evt_L1", "invoice.paid")) === false,
      "ledger: an APPLIED id is a duplicate forever, however old it is");

    rest.advance(STALE_CLAIM_MS * 10);
    ok((await led.recordEvent("evt_L1", "invoice.paid")) === false,
      "ledger: …age never makes an applied claim retakeable");

    await led.releaseEvent("evt_L1");
    ok(rest.row("evt_L1") !== null && rest.row("evt_L1").type === "invoice.paid",
      "ledger: releaseEvent cannot delete an applied row (type=like.pending:* filter)");

    await led.recordEvent("evt_L2", "checkout.session.completed");
    await led.releaseEvent("evt_L2");
    ok(rest.row("evt_L2") === null, "ledger: releaseEvent does drop a pending row");
    ok((await led.recordEvent("evt_L2", "checkout.session.completed")) === true,
      "ledger: …so the released id can be claimed again");

    // a 409 whose row is gone: a concurrent delivery released it, so nothing
    // is known to be applied — guessing "duplicate" here strands a payment
    rest.conflictNext();
    ok((await led.recordEvent("evt_L3", "invoice.paid")) === "in_flight",
      "ledger: a conflict with no row behind it asks for a retry, never 'duplicate'");

    // a read-back that fails must not read as "already applied"
    rest.breakNextRead();
    let readErr = "";
    try { await led.recordEvent("evt_L2", "checkout.session.completed"); }
    catch (e) { readErr = e.message; }
    ok(/500/.test(readErr), "ledger: a failed read-back raises instead of answering 'duplicate'");
  }

  /* ── end to end: an isolate dies mid-claim and the payment still lands ── */
  {
    const rest = stubRest();
    const led = makeEventLedger({ url: rest.url, key: "svc_key", fetch: rest.fetch, now: rest.now });
    const edb = fakeDb();
    Object.assign(edb, {
      recordEvent: led.recordEvent, markApplied: led.markApplied, releaseEvent: led.releaseEvent,
    });
    edb.seed("org7", {});
    const evt = { id: "evt_dead", type: "checkout.session.completed", created: nowSec,
      data: { object: { payment_status: "paid", customer: "cus_7",
        metadata: { org_id: "org7", plan: "program", price_id: "price_prog" } } } };

    await led.recordEvent(evt.id, evt.type);            // delivery A: claimed, then killed
    const b = await applyStripeEvent(evt, edb, PRICES); // delivery B: minutes later
    ok(statusForResult(b) >= 400 && edb.orgs.org7.plan === null,
      "stranded claim: the retry inside the window is answered non-2xx (Stripe keeps trying)");

    rest.advance(STALE_CLAIM_MS + 1000);
    const c = await applyStripeEvent(evt, edb, PRICES); // delivery C: after the window
    ok(statusForResult(c) === 200 && edb.orgs.org7.plan === "program" &&
       edb.orgs.org7.status === "active",
      "stranded claim: the delivery after the window applies the PAID checkout");
    ok(rest.row("evt_dead").type === "checkout.session.completed",
      "stranded claim: and the ledger ends up saying applied, not pending");
  }

  /* ══ billing.html's checkout gate, rendered for all eight statuses ════
   * The gate must be "a Stripe subscription actually exists", never "the
   * workspace is writable": invoice_pending is the school-invoice/PO route
   * and grace_period is the status the page itself tells people to
   * reactivate from — neither has a Stripe subscription, and both must keep
   * their button. */
  {
    const STATUSES = ["trialing", "active", "past_due", "invoice_pending",
                      "grace_period", "read_only", "canceled", "expired"];
    const org = (status, cus) => ({
      id: "org1", name: "Test Band", plan: "ensemble", status: status,
      stripe_customer_id: cus || null,
      trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      renews_at: null, grace_ends_at: null, billing_owner_user_id: "u1",
      storage_used_bytes: 1024, storage_quota_bytes: 10737418240,
    });
    const hasButton = (html, key) => html.indexOf('data-checkout="' + key + '"') >= 0;
    const labelOf = (html, key) =>
      (new RegExp('data-checkout="' + key + '">([^<]*)<').exec(html) || [])[1] || "";
    // what pressing the button on the plan you are already on would DO
    const CTA = {
      trialing: "Switch to card billing", active: "Switch to card billing",
      past_due: "Switch to card billing", invoice_pending: "Pay by card instead",
      grace_period: "Reactivate by card", read_only: "Reactivate by card",
      canceled: "Reactivate by card", expired: "Reactivate by card",
    };
    const table = [];

    for (const status of STATUSES) {
      const withCus = await renderBilling(org(status, "cus_live"));
      const noCus = await renderBilling(org(status, null));
      const stripeSub = status === "active" || status === "past_due";
      table.push([status, hasButton(withCus, "ensemble"),
        hasButton(noCus, "ensemble") ? labelOf(noCus, "ensemble") : "—"]);

      ok(hasButton(withCus, "ensemble") === !stripeSub,
        `billing/${status}: with a Stripe customer, the current plan ` +
        (stripeSub ? "hides checkout (a second subscription would fight the first)"
                   : "still offers checkout"));
      ok(hasButton(noCus, "ensemble"),
        `billing/${status}: with NO Stripe customer, the current plan always offers checkout`);
      ok(labelOf(noCus, "ensemble") === CTA[status],
        `billing/${status}: the button says what it would do ("${CTA[status]}")`);
      ok(!stripeSub || /billed by card/.test(withCus),
        `billing/${status}: the suppression copy only claims a card subscription that exists`);
      ok(hasButton(noCus, "pro") && labelOf(noCus, "pro") === "Pay by card",
        `billing/${status}: another plan is plain "Pay by card"`);
      ok(hasButton(noCus, "program"), `billing/${status}: …and every other plan is buyable`);
      ok(!hasButton(noCus, "trial"), `billing/${status}: the trial is never a checkout`);
      // a live card subscription does not hide the OTHER plans (no upgrade
      // path exists yet), so the page has to warn that checkout starts a
      // second subscription rather than moving the one that exists
      ok(!stripeSub || (hasButton(withCus, "pro") && /Changing plans:/.test(withCus)),
        `billing/${status}: buying a different plan is still possible, and warns about ` +
        "the second subscription it would start");
      ok(stripeSub || !/Changing plans:/.test(noCus),
        `billing/${status}: …and that warning is absent when there is no card subscription`);
    }

    // the button an invoice/grace workspace gets is the one the page's own
    // status line promises, and it is not disabled for the wrong reason
    const grace = await renderBilling(org("grace_period", null));
    ok(/reactivate to avoid going read-only/.test(grace) && /Reactivate by card/.test(grace),
      "billing/grace_period: the page promises a way to reactivate and renders one");
    const inv = await renderBilling(org("invoice_pending", null));
    ok(/Waiting on a school invoice/.test(inv) && /Pay by card instead/.test(inv),
      "billing/invoice_pending: the school-invoice route keeps a card option");
    ok(!/disabled/.test(inv), "billing/invoice_pending: nothing on the page is disabled");

    // #9 stays fixed: a lapsed workspace can still pay, and the only reason
    // a button is ever disabled is the missing permission
    const ro = await renderBilling(org("read_only", "cus_live"));
    ok(hasButton(ro, "ensemble") && /Reactivate by card/.test(ro),
      "billing/read_only: a lapsed workspace can reactivate by card");
    const noPerm = await renderBilling(org("read_only", null), { canBill: false });
    ok(!hasButton(noPerm, "ensemble") && /Only billing managers/.test(noPerm),
      "billing: without billing.manage the button is disabled, and says why");

    /* The OTHER way a workspace is already paid up, and the one the fixtures
       above cannot see because they set renews_at: null. padmin_mark_invoice_paid
       -> padmin_set_plan (0015) writes status 'active' and renews_at from the
       invoice period and leaves stripe_customer_id NULL. hasCardSub is false
       for that org, so a gate that keys on it alone hands the workspace a
       "Switch to card billing" button on the plan it has already bought —
       press it and Stripe takes another $149 today, then
       checkout.session.completed overwrites renews_at with event time + 365
       days, erasing whatever term was left. */
    const paidByInvoice = (renewsInDays) => ({
      ...org("active", null),
      renews_at: new Date(Date.now() + renewsInDays * 86400000).toISOString(),
    });
    const invoicePaid = await renderBilling(paidByInvoice(300));
    ok(!hasButton(invoicePaid, "ensemble"),
      "billing/invoice-paid: a workspace paid through by invoice is offered NO card checkout " +
      "on the plan it already owns");
    ok(/paid through/.test(invoicePaid) && /charge the full year again/.test(invoicePaid),
      "billing/invoice-paid: …and is told what a card subscription would actually do to it");
    ok(hasButton(invoicePaid, "pro") && /Changing plans:/.test(invoicePaid),
      "billing/invoice-paid: a DIFFERENT plan is still buyable, with the double-charge warning");
    // the suppression is about a term that still has time left on it, not
    // about the invoice route forever: an expired term is buyable again
    const invoiceLapsed = await renderBilling(paidByInvoice(-1));
    ok(hasButton(invoiceLapsed, "ensemble"),
      "billing/invoice-lapsed: once the paid term has passed, checkout comes back");

    // the client-side guard in startCheckout must agree with the card it drew
    const page = read("docs/ensemble/billing.html");
    const guard = page.slice(page.indexOf("async function startCheckout("));
    ok(/planKeyOf\(S\.org\) === plan && hasCardSub\(S\.org\)/.test(guard),
      "billing: startCheckout blocks only on a real card subscription, not on writability");
    ok(/planKeyOf\(S\.org\) === plan && paidElsewhere\(S\.org\)/.test(guard),
      "billing: startCheckout also refuses to double-charge a term paid by invoice");

    console.log("  billing.html — the CURRENT plan's checkout button, all eight statuses");
    console.log(`    ${"status".padEnd(16)} ${"with stripe_customer_id".padEnd(24)} without`);
    table.forEach(([s, a, b]) =>
      console.log(`    ${s.padEnd(16)} ${(a ? "button" : "no button (has a sub)").padEnd(24)} ${b}`));
  }

  // every mutation was audited
  ok(db.logs.length >= 5, `state changes audited (${db.logs.length} entries)`);

  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) { console.log(`FAIL ${fail.length}`); fail.forEach((m) => console.log("  FAIL " + m)); process.exit(1); }
})();
