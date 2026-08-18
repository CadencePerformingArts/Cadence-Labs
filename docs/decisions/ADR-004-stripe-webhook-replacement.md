# ADR-004 — Replacing the deployed Stripe webhook

**Status:** accepted, applied to the live project 2026-08-18
**Supersedes:** the `stripe-webhook` edge function deployed 2026-08-06 (v6)

## Context

While deploying the new organization-billing edge functions, the live
Supabase project turned out to already have a `stripe-webhook` function — at
version 6, from an earlier generation of Cadence. It was not the code in this
repository, and nobody would have noticed: it answers requests, so a probe
that only checks "does it respond" reports green.

Reading its source showed three problems, in ascending order of seriousness.

1. **It fulfils the wrong product.** It writes `plus_entitlements` /
   `plus_pending` — "Cadence Plus", a per-user subscription from before the
   organization workspaces existed. The current product sells workspace
   plans against `organizations`. A real payment would have granted nothing
   a customer could see.

2. **It has no idempotency ledger.** Stripe redelivers; every redelivery was
   reprocessed. The writes are upserts so the damage is bounded, but
   "bounded" is not the same as "correct".

3. **It processes events whose signature did not verify.** On verification
   failure it logged the failure and fell through to a "fetch-back": parse
   the body for an `evt_…` id and re-retrieve that event from Stripe's API
   with the secret key. The intent is defensible — only data Stripe itself
   confirms is acted on — but it destroys what the signature is actually
   for. A signature proves *this specific delivery*, *now*, came from
   Stripe. Fetch-back proves only that the id names a real event, so anyone
   who learns an event id can replay it, unsigned, from anywhere, as often
   as they like. Combined with (2), replay meant re-fulfilment.

Evidence gathered before changing anything: zero organizations, zero rows in
`stripe_events`, one row in `plus_entitlements` (the owner's own, status
`none`), no products and no webhook endpoints in the Stripe account
reachable from this session. Nothing was in flight, and no customer could be
affected.

## Decision

Deploy the repository's `supabase/functions/stripe-webhook` over it.

The replacement verifies the raw-body HMAC against `STRIPE_WEBHOOK_SECRET`
with a 300-second timestamp tolerance and **returns 400 if it does not
match** — there is no second path. It records every event id in
`stripe_events` (RLS on, no policies, service role only) before doing any
work, so a redelivery is a no-op. It applies absolute state, never
increments, so out-of-order delivery is safe. Handlers write
`organizations`, and only ever through the service role, because plan fields
are locked against client writes at the database level.

`stripe-checkout` was deployed alongside it (it had never been deployed at
all) with `verify_jwt` on. It checks `billing.manage` **as the caller**,
inside the database, before it will create a Checkout Session.

Both are inert until the owner sets test-mode secrets: `stripe-checkout`
answers `503 billing_not_configured` without `STRIPE_SECRET_KEY`.

## Consequences

- Cadence Plus fulfilment is gone from the live project. It had no
  subscribers and nothing on the site sells it. If it is ever revived it
  needs its own function and its own idempotency ledger, not a fallback
  inside the workspace webhook.
- A `STRIPE_WEBHOOK_SECRET` from the old generation is still set on the
  project. It must be replaced with the signing secret of whatever endpoint
  the owner creates, or real deliveries will be rejected — correctly, and
  visibly, which is the point.
- Verified after deploying: an unsigned POST gets
  `400 invalid signature: missing input`; a forged signature with a fresh
  timestamp gets `400 invalid signature: signature mismatch`; `GET` gets
  `405`. Not one of them reaches a handler.

## The previous source

Kept here verbatim so the decision is reversible in one deploy.

```ts
// Stripe → Cadence fulfillment webhook.
// Auth: Stripe signature verification, with an API fetch-back fallback —
// if the signature can't be verified (secret mismatch), the event is
// re-fetched from Stripe by ID with the secret key, so only events Stripe
// itself confirms are ever processed. Never JWT.
import Stripe from 'npm:stripe@18';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

type Patch = {
  status: string;
  plan: string | null;
  stripe_customer_id: string | null;
  since?: string;
};

async function applyByEmail(email: string | null, patch: Patch) {
  if (!email) return;
  const { data: uid } = await admin.rpc('get_user_id_by_email', { p_email: email });
  if (uid) {
    await admin.from('plus_entitlements').upsert({
      user_id: uid,
      status: patch.status,
      source: 'stripe',
      plan: patch.plan,
      stripe_customer_id: patch.stripe_customer_id,
      since: patch.since ?? new Date().toISOString(),
    });
  } else {
    await admin.from('plus_pending').upsert({
      email: email.toLowerCase(),
      stripe_customer_id: patch.stripe_customer_id,
      plan: patch.plan,
      status: patch.status,
    });
  }
}

function planOfInterval(interval?: string | null) {
  return interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : null;
}

Deno.serve(async (req) => {
  const whsec = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const sig = req.headers.get('stripe-signature');
  const body = await req.text();
  let event: Stripe.Event | null = null;

  if (whsec && sig) {
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, whsec, undefined, cryptoProvider);
    } catch (err) {
      console.error('signature verification failed — falling back to API fetch-back:', (err as Error).message);
    }
  } else {
    console.error('config: STRIPE_WEBHOOK_SECRET or stripe-signature missing — using API fetch-back');
  }

  if (!event) {
    // fetch-back: trust only what Stripe's API returns for this event id
    let claimedId: string | null = null;
    try { claimedId = JSON.parse(body)?.id ?? null; } catch { /* not JSON */ }
    if (!claimedId || !claimedId.startsWith('evt_')) {
      return new Response('unverifiable payload', { status: 400 });
    }
    try {
      event = await stripe.events.retrieve(claimedId);
    } catch (err) {
      console.error('fetch-back failed — event unknown to Stripe or STRIPE_SECRET_KEY unset:', (err as Error).message);
      return new Response('unverifiable event', { status: 400 });
    }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription' && session.mode !== 'payment') break;
        let plan: string | null = null;
        try {
          const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
          plan = planOfInterval(items.data[0]?.price?.recurring?.interval);
        } catch { /* plan stays null; entitlement still granted */ }
        await applyByEmail(session.customer_details?.email ?? null, {
          status: 'active',
          plan,
          stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
        });
        console.log('granted via checkout.session.completed');
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const alive = ['active', 'trialing', 'past_due'].includes(sub.status) &&
          event.type !== 'customer.subscription.deleted';
        const patch: Patch = {
          status: alive ? 'active' : 'canceled',
          plan: planOfInterval(sub.items?.data[0]?.price?.recurring?.interval),
          stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : null,
          since: new Date((sub.start_date ?? sub.created) * 1000).toISOString(),
        };
        if (patch.stripe_customer_id) {
          const { data: hit } = await admin
            .from('plus_entitlements')
            .update({ status: patch.status, plan: patch.plan, source: 'stripe' })
            .eq('stripe_customer_id', patch.stripe_customer_id)
            .select('user_id');
          if (hit && hit.length) { console.log('updated by customer id'); break; }
        }
        try {
          const cust = await stripe.customers.retrieve(patch.stripe_customer_id!);
          if (!('deleted' in cust)) {
            await applyByEmail(cust.email, patch);
            console.log('applied by email for', event.type);
          }
        } catch (e) {
          console.error('customer lookup failed — is STRIPE_SECRET_KEY set?', (e as Error).message);
        }
        break;
      }
      default:
        break; // unhandled event types are acknowledged, not errors
    }
  } catch (err) {
    console.error('fulfillment error', event.type, err);
    return new Response('fulfillment error', { status: 500 }); // Stripe retries
  }
  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```
