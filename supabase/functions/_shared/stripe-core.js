/* Stripe billing core — the logic shared by the edge functions and the Node
 * test suite (scripts/test_stripe_core.js). No SDK: signature verification is
 * Web Crypto (available in Deno and Node 18+), Stripe API calls live in the
 * functions, and the subscription state machine here is deterministic and
 * fully unit-tested with signed fixtures. The one piece of I/O that lives
 * here — makeEventLedger — takes its `fetch` as an argument precisely so the
 * ledger semantics are exercised by tests instead of only in production.
 *
 * SECURITY MODEL
 *   - The webhook trusts NOTHING but the signature: raw body + the
 *     `stripe-signature` header + the endpoint secret, with a timestamp
 *     tolerance against replay.
 *   - Every event id is CLAIMED before its handler runs (stripe_events,
 *     service-role only) and marked applied only when the handler finishes;
 *     a second delivery of an applied id is a no-op. Out-of-order deliveries
 *     and re-runs are safe because handlers set absolute state, never
 *     increments — INCLUDING every deadline they write, which is derived from
 *     the event's own `created` timestamp and never from the wall clock, so
 *     applying one event twice produces byte-identical fields. Nothing here
 *     may call Date.now() to build a stored value.
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

/* ── the claim ledger (stripe_events, 0016) ──────────────────────────────
 * The only I/O in this file, and it lives here rather than in the edge
 * function for one reason: the `pending:` prefix, the 409 read-back and the
 * stale-claim arithmetic are the riskiest lines in the whole webhook, and a
 * factory that takes its `fetch` can be driven by scripts/test_stripe_core.js
 * against a stub PostgREST. The function passes the real fetch and nothing
 * else changes.
 *
 * A row is written as `pending:<type>` when the claim is taken and rewritten
 * to `<type>` when the handler has finished, so one text column distinguishes
 * "running" from "applied" with the schema 0016 already has.            */
export const PENDING = "pending:";
/* A claim whose isolate was killed between claiming and releasing is
 * unreachable until someone decides it is dead. Ten minutes is far longer
 * than any handler (a handful of PostgREST calls) and far shorter than the
 * days Stripe keeps retrying, so the stranded claim is retaken by a later
 * delivery rather than swallowed forever. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export function makeEventLedger(opts) {
  const o = opts || {};
  const base = String(o.url || "").replace(/\/+$/, "") + "/rest/v1/";
  const doFetch = o.fetch;
  const now = o.now || Date.now;
  const staleMs = o.staleMs == null ? STALE_CLAIM_MS : o.staleMs;
  const auth = { apikey: o.key, Authorization: "Bearer " + o.key };
  const byId = (id) => "stripe_events?id=eq." + encodeURIComponent(id);

  async function write(path, init) {
    const res = await doFetch(base + path, {
      ...init,
      headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
    });
    // 409 is the unique-violation this table exists to produce; anything else
    // in the error range is a real failure and must not read as "duplicate"
    if (!res.ok && res.status !== 409) {
      throw new Error(path + " -> " + res.status + " " + await res.text());
    }
    return res;
  }

  async function readRow(id) {
    const res = await doFetch(base + byId(id) + "&select=type,received_at", { headers: auth });
    if (!res.ok) throw new Error("stripe_events read -> " + res.status + " " + await res.text());
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("stripe_events read: unexpected body");
    return rows[0] || null;
  }

  return {
    async recordEvent(id, type) {
      // the primary key IS the idempotency gate: 409 means someone was first
      const res = await write("stripe_events", {
        method: "POST", body: JSON.stringify({ id, type: PENDING + type }),
      });
      if (res.status !== 409) return true;
      const row = await readRow(id);
      // the row vanished between the insert and the read: a concurrent
      // delivery released its claim, so nothing is known to have been
      // applied — never answer "duplicate" on a guess
      if (!row) return "in_flight";
      // a bare type is a FINISHED application: final, forever
      if (!String(row.type).startsWith(PENDING)) return false;
      const age = now() - Date.parse(row.received_at);
      // written as `!(age >= staleMs)` so an unparseable timestamp asks for a
      // retry instead of racing another live delivery
      if (!(age >= staleMs)) return "in_flight";
      await write(byId(id), {
        method: "PATCH", body: JSON.stringify({ received_at: new Date(now()).toISOString() }),
      });
      return true;
    },
    async markApplied(id, type) {
      await write(byId(id), { method: "PATCH", body: JSON.stringify({ type }) });
    },
    async releaseEvent(id) {
      // the type filter makes this incapable of dropping an APPLIED row
      await write(byId(id) + "&type=like." + PENDING + "*", { method: "DELETE" });
    },
  };
}

/* ── the event state machine ─────────────────────────────────────────────
 * db contract (the three claim methods are implemented against Supabase with
 * the service role by makeEventLedger above):
 *   recordEvent(id, type)  -> true         claimed, run the handler
 *                             false        already APPLIED — a real no-op
 *                             "in_flight"  claimed by a delivery that has not
 *                                          finished (or died mid-flight)
 *   markApplied(id, type)  -> void   (optional: the claim becomes final)
 *   releaseEvent(id)       -> void   (optional: hand an unapplied claim back)
 *   orgByCustomer(cusId)   -> { id, plan, status } | null
 *   update(orgId, fields)  -> void   (absolute state, service role)
 *   log(action, orgId, detail) -> void
 * Returns { handled, action } — plus retry:true when the caller must answer a
 * non-2xx (see statusForResult) — for observability.
 *
 * IDEMPOTENCY, precisely. The id is claimed BEFORE the handler runs and
 * marked applied AFTER it succeeds, so a redelivery of an already-applied
 * event stays a no-op forever. A handler that THROWS releases the claim
 * first: that application did not happen, the caller answers 500, and
 * Stripe's retry has to be allowed to try again — a consumed id would strand
 * a PAID checkout on an unactivated organization with no path to recovery.
 *
 * The two rejections are NOT the same answer. "Already applied" is final and
 * earns a 2xx. "Claim in flight" is not: the isolate holding it may have been
 * killed between claiming and releasing, and a 2xx would tell Stripe the
 * event was delivered and end its retries — after which nothing ever revisits
 * the pending row and the same paid checkout is stranded through a narrower
 * door. So an in-flight claim asks for a retry; the ledger lets a claim be
 * retaken once it is stale, and Stripe keeps retrying for days.           */
export async function applyStripeEvent(evt, db, priceMap) {
  if (!evt || !evt.id || !evt.type) return { handled: false, action: "malformed" };
  const claim = await db.recordEvent(evt.id, evt.type);
  if (claim === "in_flight") {
    return { handled: false, action: "in flight", retry: true };
  }
  if (!claim) return { handled: false, action: "duplicate" };

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
  // The application happened; the ledger now has to say so. A swallowed
  // failure here would answer 2xx over a row still reading `pending:<type>`:
  // indistinguishable from a dead claim in the ledger the runbook tells the
  // owner to read, and never revisited because Stripe was told it was done.
  // Raising instead costs one redelivery — handlers are absolute, so the
  // retry re-applies the same state and marks the claim for real.
  if (db.markApplied) {
    try { await db.markApplied(evt.id, evt.type); }
    catch (e) {
      throw new Error("applied " + evt.type + " (" + out.action + ") for " + evt.id +
        " but could not mark the claim applied: " + String((e && e.message) || e));
    }
  }
  return out;
}

/* The HTTP status the webhook answers for a result. Anything in 2xx tells
 * Stripe the event is delivered and ends the retries, so a result that still
 * needs another delivery must fall outside it — 409 says "someone else holds
 * this claim", which is exactly what happened. */
export function statusForResult(out) {
  return out && out.retry ? 409 : 200;
}

/* the event's own clock in ms — every date a handler STORES is derived from
 * this, so re-running an event is a byte-identical write. Stripe always sends
 * `created`; the fallback only exists so a hand-made payload cannot produce
 * an Invalid Date. */
function eventTimeMs(evt) {
  const t = evt && Number(evt.created);
  return Number.isFinite(t) && t > 0 ? t * 1000 : Date.now();
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
        renews_at: new Date(eventTimeMs(evt) + 365 * 86400000).toISOString(),
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
      // 14 days from the EVENT, not from now: a redelivery of this same event
      // (a released claim, a stale claim retaken, Stripe's "Resend") has to
      // land on the identical deadline. Date.now() here would walk the grace
      // period forward on every retry and quietly break the absolute-state
      // promise the whole idempotency design rests on.
      await db.update(org.id, {
        status: "past_due",
        grace_ends_at: new Date(eventTimeMs(evt) + 14 * 86400000).toISOString(),
      });
      await db.log("stripe.payment_failed", org.id, {});
      return { handled: true, action: "past_due" };
    }

    default:
      return { handled: true, action: "ignored type" };
  }
}
