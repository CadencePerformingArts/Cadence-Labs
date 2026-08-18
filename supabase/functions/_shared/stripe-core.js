/* Stripe billing core — pure logic shared by the edge functions and the
 * Node test suite (scripts/test_stripe_core.js). No SDK: signature
 * verification is Web Crypto (available in Deno and Node 18+), Stripe API
 * calls live in the functions, and the subscription state machine here is
 * deterministic and fully unit-tested with signed fixtures.
 *
 * SECURITY MODEL
 *   - The webhook trusts NOTHING but the signature: raw body + the
 *     `stripe-signature` header + the endpoint secret, with a timestamp
 *     tolerance against replay.
 *   - Every event id is CLAIMED before its handler runs (stripe_events,
 *     service-role only) and marked applied only when the handler finishes;
 *     a second delivery of an applied id is a no-op. Out-of-order deliveries
 *     are safe because handlers set absolute state, never increments.
 *   - The database — not a browser redirect — grants access: only the
 *     webhook (service role) flips an organization's plan on card payments.
 */

/* ── signature verification (Stripe v1 scheme) ───────────────────────── */
export async function verifyStripeSignature({ payload, header, secret, toleranceSec = 300, now = Date.now }) {
  if (!payload || !header || !secret) return { ok: false, reason: "missing input" };
  const parts = {};
  for (const kv of String(header).split(",")) {
    const [k, v] = kv.split("=", 2);
    if (k === "t") parts.t = v;
    else if (k === "v1") (parts.v1 = parts.v1 || []).push(v);
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) return { ok: false, reason: "malformed header" };
  const age = Math.abs(now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time compare against each provided v1
  const match = parts.v1.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
  return match ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/* helper for tests and local tools: produce a valid header for a payload */
export async function signStripePayload(payload, secret, tSec) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${tSec}.${payload}`));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${tSec},v1=${sig}`;
}

/* ── price → plan mapping (price ids come from env, never hardcoded) ──── */
export function planFromPrice(priceMap, priceId) {
  // priceMap: { ensemble: 'price_…', pro: 'price_…', program: 'price_…' }
  for (const [plan, id] of Object.entries(priceMap || {})) {
    if (id && id === priceId) return plan;
  }
  return null;
}

const QUOTAS = { ensemble: 10737418240, pro: 26843545600, program: 107374182400 };

/* ── the event state machine ─────────────────────────────────────────────
 * db contract (implemented against Supabase with the service role):
 *   recordEvent(id, type)  -> false if this id is already claimed or applied
 *   markApplied(id, type)  -> void   (optional: the claim becomes final)
 *   releaseEvent(id)       -> void   (optional: hand an unapplied claim back)
 *   orgByCustomer(cusId)   -> { id, plan, status } | null
 *   update(orgId, fields)  -> void   (absolute state, service role)
 *   log(action, orgId, detail) -> void
 * Returns { handled, action } for observability.
 *
 * IDEMPOTENCY, precisely. The id is claimed BEFORE the handler runs, so an
 * overlapping redelivery is dropped, and marked applied AFTER it succeeds,
 * so a redelivery of an already-applied event stays a no-op forever. A
 * handler that THROWS releases the claim first: that application did not
 * happen, the caller answers 500, and Stripe's retry has to be allowed to
 * try again — a consumed id would strand a PAID checkout on an
 * unactivated organization with no path to recovery.                     */
export async function applyStripeEvent(evt, db, priceMap) {
  if (!evt || !evt.id || !evt.type) return { handled: false, action: "malformed" };
  const fresh = await db.recordEvent(evt.id, evt.type);
  if (!fresh) return { handled: false, action: "duplicate" };

  let out;
  try {
    out = await runHandler(evt, db, priceMap);
  } catch (e) {
    if (db.releaseEvent) {
      // a release that itself fails leaves the id consumed — say so in the
      // error rather than losing a payment quietly
      try { await db.releaseEvent(evt.id); }
      catch (e2) {
        throw new Error(String((e && e.message) || e) +
          " — claim not released: " + String((e2 && e2.message) || e2));
      }
    }
    throw e;
  }
  // only a completed application makes the claim final; a failure to mark it
  // is not worth a retry (the work is done, and the state is absolute)
  if (db.markApplied) { try { await db.markApplied(evt.id, evt.type); } catch (e) {} }
  return out;
}

async function runHandler(evt, db, priceMap) {
  const obj = (evt.data && evt.data.object) || {};

  switch (evt.type) {
    case "checkout.session.completed": {
      // the session we created carries org_id in metadata; payment_status
      // must be paid before anything is granted
      const orgId = obj.metadata && obj.metadata.org_id;
      if (!orgId || obj.payment_status !== "paid") return { handled: true, action: "ignored" };
      const plan = planFromPrice(priceMap, obj.metadata.price_id) ||
                   (obj.metadata.plan && QUOTAS[obj.metadata.plan] ? obj.metadata.plan : null);
      if (!plan) return { handled: true, action: "unknown price" };
      await db.update(orgId, {
        plan, status: "active",
        stripe_customer_id: obj.customer || null,
        renews_at: new Date((evt.created + 365 * 86400) * 1000).toISOString(),
        grace_ends_at: null,
        storage_quota_bytes_min: QUOTAS[plan],   // db.update applies as greatest()
      });
      await db.log("stripe.checkout_completed", orgId, { plan });
      return { handled: true, action: "activated " + plan };
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const org = await db.orgByCustomer(obj.customer);
      if (!org) return { handled: true, action: "no such customer" };
      const priceId = obj.items && obj.items.data && obj.items.data[0] &&
                      obj.items.data[0].price && obj.items.data[0].price.id;
      const plan = planFromPrice(priceMap, priceId) || org.plan;
      const status =
        obj.status === "active" || obj.status === "trialing" ? "active"
        : obj.status === "past_due" ? "past_due"
        : obj.status === "unpaid" || obj.status === "canceled" ? "read_only"
        : null;
      if (!status) return { handled: true, action: "ignored status " + obj.status };
      const fields = { plan, status };
      if (obj.current_period_end) {
        fields.renews_at = new Date(obj.current_period_end * 1000).toISOString();
      }
      if (plan && QUOTAS[plan]) fields.storage_quota_bytes_min = QUOTAS[plan];
      await db.update(org.id, fields);
      await db.log("stripe.subscription_" + obj.status, org.id, { plan });
      return { handled: true, action: status + "/" + plan };
    }

    case "customer.subscription.deleted": {
      const org = await db.orgByCustomer(obj.customer);
      if (!org) return { handled: true, action: "no such customer" };
      // history is never deleted — the workspace goes read-only
      await db.update(org.id, { status: "read_only" });
      await db.log("stripe.subscription_deleted", org.id, {});
      return { handled: true, action: "read_only" };
    }

    case "invoice.paid": {
      const org = await db.orgByCustomer(obj.customer);
      if (!org) return { handled: true, action: "no such customer" };
      const fields = { status: "active", grace_ends_at: null };
      const line = obj.lines && obj.lines.data && obj.lines.data[0];
      if (line && line.period && line.period.end) {
        fields.renews_at = new Date(line.period.end * 1000).toISOString();
      }
      await db.update(org.id, fields);
      await db.log("stripe.invoice_paid", org.id, {});
      return { handled: true, action: "renewed" };
    }

    case "invoice.payment_failed": {
      const org = await db.orgByCustomer(obj.customer);
      if (!org) return { handled: true, action: "no such customer" };
      await db.update(org.id, {
        status: "past_due",
        grace_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
      });
      await db.log("stripe.payment_failed", org.id, {});
      return { handled: true, action: "past_due" };
    }

    default:
      return { handled: true, action: "ignored type" };
  }
}
