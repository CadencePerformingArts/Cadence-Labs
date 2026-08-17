// Cadence — create a Stripe Checkout Session for an organization plan
// (Supabase Edge Function, Deno). The browser never talks to Stripe's
// privileged APIs: it calls this with the user's own JWT, this verifies
// billing authority IN THE DATABASE, then creates the session server-side.
//
//   supabase functions deploy stripe-checkout
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_… \
//     STRIPE_PRICE_ENSEMBLE=price_… STRIPE_PRICE_PRO=price_… \
//     STRIPE_PRICE_PROGRAM=price_… SITE_URL=https://…/Cadence-Labs
//
// Test mode first: with an sk_test_ key no real card is ever charged.
// Body: { org_id, plan: 'ensemble'|'pro'|'program' }. Returns { url }.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SITE = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const PRICES: Record<string, string> = {
  ensemble: Deno.env.get("STRIPE_PRICE_ENSEMBLE") ?? "",
  pro: Deno.env.get("STRIPE_PRICE_PRO") ?? "",
  program: Deno.env.get("STRIPE_PRICE_PROGRAM") ?? "",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cors });
  if (!STRIPE_KEY) {
    return new Response(JSON.stringify({ error: "billing_not_configured" }),
      { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response(JSON.stringify({ error: "auth_required" }),
    { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  let body: { org_id?: string; plan?: string };
  try { body = await req.json(); } catch { body = {}; }
  const orgId = body.org_id ?? "";
  const plan = body.plan ?? "";
  if (!PRICES[plan]) {
    return new Response(JSON.stringify({ error: "bad_plan" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // authority check runs AS THE CALLER (their JWT), inside the database:
  // billing.manage (or org.admin, which implies it) on this exact org
  const perm = await fetch(`${SB_URL}/rest/v1/rpc/org_has_perm`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_org: orgId, p_perm: "billing.manage" }),
  });
  if (!perm.ok || (await perm.text()) !== "true") {
    return new Response(JSON.stringify({ error: "billing_manage_required" }),
      { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // resolve the caller's user id (for metadata/audit) from their JWT
  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` } });
  const user = who.ok ? await who.json() : null;

  // reuse the org's Stripe customer if it has one
  const orgRes = await fetch(
    `${SB_URL}/rest/v1/organizations?id=eq.${orgId}&select=stripe_customer_id,name,slug`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const org = (await orgRes.json())[0];
  if (!org) return new Response(JSON.stringify({ error: "no_such_org" }),
    { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": PRICES[plan],
    "line_items[0][quantity]": "1",
    success_url: `${SITE}/ensemble/billing.html?checkout=success`,
    cancel_url: `${SITE}/ensemble/billing.html?checkout=canceled`,
    "metadata[org_id]": orgId,
    "metadata[plan]": plan,
    "metadata[price_id]": PRICES[plan],
    "metadata[user_id]": user?.id ?? "",
    "subscription_data[metadata][org_id]": orgId,
  });
  if (org.stripe_customer_id) form.set("customer", org.stripe_customer_id);
  else if (user?.email) form.set("customer_email", user.email);

  const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // one session per org+plan+day: double-clicks reuse it
      "Idempotency-Key": `co-${orgId}-${plan}-${new Date().toISOString().slice(0, 10)}`,
    },
    body: form,
  });
  const session = await stripe.json();
  if (!stripe.ok) {
    return new Response(JSON.stringify({ error: session?.error?.message ?? "stripe_error" }),
      { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ url: session.url }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
