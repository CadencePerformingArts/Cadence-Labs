// Cadence — Stripe webhook (Supabase Edge Function, Deno).
//
// The ONLY component that grants workspace plans on card payments. Verifies
// the raw-body signature, dedupes by event id, then applies absolute state
// through the service role. Deploy:
//
//   supabase functions deploy stripe-webhook --no-verify-jwt
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… \
//     STRIPE_PRICE_ENSEMBLE=price_… STRIPE_PRICE_PRO=price_… \
//     STRIPE_PRICE_PROGRAM=price_…
//
// (--no-verify-jwt because Stripe cannot send a Supabase JWT; the Stripe
// signature IS the authentication.) Point the Stripe endpoint at
//   https://<project-ref>.functions.supabase.co/stripe-webhook
// with events: checkout.session.completed, customer.subscription.created/
// updated/deleted, invoice.paid, invoice.payment_failed.
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// Test-mode first: use whsec_/price_ values from test mode until launch.

import { verifyStripeSignature, applyStripeEvent } from "../_shared/stripe-core.js";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const PRICES = {
  ensemble: Deno.env.get("STRIPE_PRICE_ENSEMBLE") ?? "",
  pro: Deno.env.get("STRIPE_PRICE_PRO") ?? "",
  program: Deno.env.get("STRIPE_PRICE_PROGRAM") ?? "",
};

async function rest(path: string, init: RequestInit) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

const db = {
  async recordEvent(id: string, type: string) {
    // unique PK makes this the idempotency gate: 409 = already processed
    const res = await rest("stripe_events", {
      method: "POST",
      body: JSON.stringify({ id, type }),
    });
    return res.status !== 409;
  },
  async orgByCustomer(cus: string | null) {
    if (!cus) return null;
    const res = await fetch(
      `${SB_URL}/rest/v1/organizations?stripe_customer_id=eq.${encodeURIComponent(cus)}&select=id,plan,status`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = await res.json();
    return rows[0] ?? null;
  },
  async update(orgId: string, fields: Record<string, unknown>) {
    const body: Record<string, unknown> = { ...fields };
    // storage minimums apply as a floor, never shrinking a bigger grant
    if ("storage_quota_bytes_min" in body) {
      const min = body.storage_quota_bytes_min as number;
      delete body.storage_quota_bytes_min;
      const cur = await fetch(
        `${SB_URL}/rest/v1/organizations?id=eq.${orgId}&select=storage_quota_bytes`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
      const rows = await cur.json();
      const have = rows[0]?.storage_quota_bytes ?? 0;
      body.storage_quota_bytes = Math.max(have, min);
    }
    await rest(`organizations?id=eq.${orgId}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  async log(action: string, orgId: string, detail: Record<string, unknown>) {
    await rest("platform_audit_log", {
      method: "POST",
      body: JSON.stringify({ action, target_type: "org", target_id: orgId, detail }),
    }).catch(() => {});
  },
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("webhook not configured", { status: 503 });

  const payload = await req.text();               // RAW body — never re-parse first
  const sig = req.headers.get("stripe-signature") ?? "";
  const v = await verifyStripeSignature({ payload, header: sig, secret: WEBHOOK_SECRET });
  if (!v.ok) return new Response(`invalid signature: ${v.reason}`, { status: 400 });

  let evt;
  try { evt = JSON.parse(payload); } catch { return new Response("bad json", { status: 400 }); }

  try {
    const out = await applyStripeEvent(evt, db, PRICES);
    return new Response(JSON.stringify(out), {
      status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    // 500 makes Stripe retry — safe, because recordEvent dedupes
    return new Response(`error: ${(e as Error).message}`, { status: 500 });
  }
});
