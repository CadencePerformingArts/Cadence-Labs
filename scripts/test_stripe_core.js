#!/usr/bin/env node
/* Tests for the Stripe billing core with SIGNED fixtures — no network,
 * no Stripe account, no secrets beyond a made-up test string.
 *
 *   node scripts/test_stripe_core.js
 *
 * Proves: signature verification (accept/reject/replay-window), event
 * idempotency, and every state transition of the subscription machine —
 * checkout activates the plan, payment failure opens a grace period,
 * renewal clears it, cancellation goes read-only (never deletes), and
 * unknown customers/prices are ignored safely.
 */
import { verifyStripeSignature, signStripePayload, applyStripeEvent, planFromPrice }
  from "../supabase/functions/_shared/stripe-core.js";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const SECRET = "whsec_test_fixture_secret";
const PRICES = { ensemble: "price_ens", pro: "price_pro", program: "price_prog" };

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

  // duplicate delivery is a no-op
  db.orgs.org1.status = "sentinel";
  r = await applyStripeEvent({
    id: "evt_co1", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "paid", customer: "cus_1",
      metadata: { org_id: "org1", plan: "ensemble", price_id: "price_ens" } } },
  }, db, PRICES);
  ok(r.action === "duplicate" && db.orgs.org1.status === "sentinel",
    "duplicate event id is a no-op");
  db.orgs.org1.status = "active";

  // unpaid checkout grants nothing
  db.seed("org2", {});
  await applyStripeEvent({
    id: "evt_co2", type: "checkout.session.completed", created: nowSec,
    data: { object: { payment_status: "unpaid", customer: "cus_2",
      metadata: { org_id: "org2", plan: "pro", price_id: "price_pro" } } },
  }, db, PRICES);
  ok(db.orgs.org2.plan === null, "unpaid checkout grants nothing");

  // payment failure -> past_due with a grace window
  await applyStripeEvent({
    id: "evt_pf1", type: "invoice.payment_failed",
    data: { object: { customer: "cus_1" } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "past_due" && db.orgs.org1.grace_ends_at,
    "payment failure opens a grace period");

  // renewal clears it
  await applyStripeEvent({
    id: "evt_ip1", type: "invoice.paid",
    data: { object: { customer: "cus_1",
      lines: { data: [{ period: { end: nowSec + 366 * 86400 } }] } } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "active" && db.orgs.org1.grace_ends_at === null,
    "invoice.paid restores active and clears grace");

  // plan change via subscription.updated
  await applyStripeEvent({
    id: "evt_su1", type: "customer.subscription.updated",
    data: { object: { customer: "cus_1", status: "active",
      current_period_end: nowSec + 400 * 86400,
      items: { data: [{ price: { id: "price_prog" } }] } } },
  }, db, PRICES);
  ok(db.orgs.org1.plan === "program" && db.orgs.org1.quota === 107374182400,
    "subscription.updated upgrades the plan and quota floor");

  // cancellation -> read-only, never deleted
  await applyStripeEvent({
    id: "evt_sd1", type: "customer.subscription.deleted",
    data: { object: { customer: "cus_1" } },
  }, db, PRICES);
  ok(db.orgs.org1.status === "read_only" && db.orgs.org1.plan === "program",
    "cancellation goes read-only and keeps history");

  // unknown customer is ignored safely
  r = await applyStripeEvent({
    id: "evt_x1", type: "invoice.paid", data: { object: { customer: "cus_nobody" } },
  }, db, PRICES);
  ok(r.action === "no such customer", "unknown customer ignored safely");

  // every mutation was audited
  ok(db.logs.length >= 5, `state changes audited (${db.logs.length} entries)`);

  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) { console.log(`FAIL ${fail.length}`); fail.forEach((m) => console.log("  FAIL " + m)); process.exit(1); }
})();
