# Cadence+ billing — implementation guide

How the sandbox scaffold (`plus.js`, `plus.html`) becomes real, paid Cadence+.
Companion to `monetization.md` (principles, feature split, refunds policy);
this file is the build order.

**Where we are today:** `docs/plus.js` stores the entitlement in
`localStorage['cad-plus']` as `{key, since}` and `activate()` accepts any code
shaped `CAD-XXXX-XXXX` — pure sandbox, no money, no server. `docs/plus.html`
is the upgrade page with placeholder prices marked "coming soon". Nothing else
in the site reads the entitlement yet.

The API contract every phase preserves: features check
`CadPlus.active()` — one boolean, never a product ID (see `monetization.md`).

---

## Phase 1 — Stripe Payment Links + emailed codes (no backend)

The smallest real-money setup: Stripe hosts the checkout, we email codes by
hand (or with Stripe's built-in email automations). Zero servers, zero code
changes beyond swapping two URLs into `plus.html`.

Flow: fan clicks a Payment Link on `plus.html` → pays on Stripe's hosted page
→ we see the payment in the Stripe dashboard → we email them a code →
they enter it in the "I have a code" box → `CadPlus.activate()` unlocks.

### Owner actions (require the owner's identity/banking — agent cannot do these)

1. Create a Stripe account at dashboard.stripe.com and complete activation
   (business details, bank account for payouts, tax info).
2. In **Product catalog**, create one product, **Cadence+**, with two
   recurring prices matching `PRICING` in docs/plus.js — currently **$1.99/month** and **$9.99/year** (the placeholders on
   `plus.html`; adjust at will — the page is the only thing that hardcodes
   them).
3. Create two **Payment Links** (one per price). In each link's settings:
   collect email address, allow promotion codes off, enable the confirmation
   page message: "Your Cadence+ code will be emailed within 24 hours."
4. Enable the **customer portal** (Settings → Billing → Customer portal) so
   subscribers can cancel themselves — no dark patterns.
5. Decide the code-issuing routine: on each `payment.succeeded` email from
   Stripe, reply to the customer with a code generated from a private list
   (any `CAD-XXXX-XXXX` string works; keep the issued list in a private
   spreadsheet so a later migration can honor them).

### Already coded / agent-doable

- `plus.js` redemption + storage, `plus.html` code UI and feedback — done.
- Swapping the two disabled "coming soon" buttons for the real Payment Link
  URLs and removing the placeholder badges — a two-line edit once the links
  exist.

### Honest limitation to accept in phase 1

With no backend, the client cannot cryptographically verify a code — anyone
who guesses the format gets Plus. That is acceptable while Plus is cheap,
the audience is friendly, and every feature is also a thank-you; it is not
acceptable at scale, which is what phase 2 fixes. Keep the sandbox note on
`plus.html` until phase 2 replaces it.

---

## Phase 2 — Supabase auth + entitlements table + Stripe webhook

Real accounts, server-validated entitlement. **The schema already exists**:
`supabase/migrations/0001_core_schema.sql` and
`supabase/migrations/0002_users_and_rls.sql` — see the `entitlements` table
in 0002: `(user_id, entitlement 'cadence_plus', active, expires_at, store
'stripe' | 'sandbox' | …, updated_at)`, with RLS so a user can read only
their own row and **only the service role writes**. The client is never
trusted to assert entitlement.

Flow: fan signs in (Supabase auth) → checkout via Stripe (now a Checkout
Session created with the user's id in `client_reference_id`) → Stripe
webhook hits a Supabase Edge Function → the function upserts
`entitlements` → the app reads the row on sign-in and caches it →
`CadPlus.active()` reflects server truth.

### Owner actions

1. Create the Supabase organization + project (free tier is fine to start;
   `monetization.md` budgets Pro at $25/mo if needed).
2. Apply the two migrations from `supabase/migrations/` to the project.
3. Enable auth providers (email magic link at minimum; Apple/Google OAuth
   recommended since phase 3 needs Apple sign-in anyway).
4. In Stripe: add a webhook endpoint pointing at the Edge Function URL,
   subscribed to `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`; copy the signing secret into Supabase secrets.
5. Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Supabase Edge
   Function secrets (never in the repo).

### Agent-doable (code to write in this phase)

- Edge Function `stripe-webhook`: verify signature, map Stripe customer →
  `user_id`, upsert `entitlements` (`store='stripe'`, `expires_at` from the
  subscription period end, `active` per status — grace periods keep it true).
- Edge Function `redeem-code`: validates beta codes server-side and writes
  `entitlements` with `store='sandbox'`, honoring phase-1 codes so early
  supporters keep Plus.
- Client: Supabase JS auth glue; `plus.js` gains an async refresh that reads
  the user's entitlement row and mirrors it into `localStorage['cad-plus']`
  as a cache (API unchanged; `active()` stays synchronous off the cache).
- Migrating `favorites` / `notification_prefs` to the account is optional
  gravy enabled by the same tables.

---

## Phase 3 — Native apps + RevenueCat

When Cadence ships in the App Store / Play Store, in-app purchase rules
apply. `monetization.md` covers the full policy; mechanically:

- One RevenueCat entitlement, **`plus`**; App Store and Play products map to
  it. RevenueCat validates receipts server-side.
- RevenueCat webhook → the same Supabase `entitlements` table (`store` =
  `'app_store'` / `'play_store'`), so web and native agree on one row and the
  schema needs **no changes** — it was designed for this (see the comment
  above `entitlements` in 0002).
- Restore purchases button, billing grace periods, cancel links straight to
  platform subscription management — all mandatory, all per `monetization.md`.

### Owner actions

1. Apple Developer account ($99/yr) + signed Paid Applications agreement;
   Google Play Console ($25 once). Banking/tax forms on both.
2. Create the RevenueCat account, connect store credentials, define the
   `plus` entitlement and offerings.
3. Create the in-app products in App Store Connect / Play Console with real
   prices; submit for review.
4. Point the RevenueCat webhook at the Supabase Edge Function.

### Agent-doable

- RevenueCat SDK integration in the native shells, paywall UI reusing the
  `plus.html` content, `revenuecat-webhook` Edge Function, sandbox test plans
  (StoreKit sandbox / Play license testers), store metadata drafts.

---

## Quick reference — who does what

| Step | Owner (accounts/money) | Already coded / agent |
| --- | --- | --- |
| Entitlement storage + API | — | `docs/plus.js` (done) |
| Upgrade page + code UI | — | `docs/plus.html` (done) |
| DB schema for entitlements | run migrations (P2) | `supabase/migrations/` (done) |
| Stripe account, products, Payment Links | P1 steps 1–4 | swap links into `plus.html` |
| Issue beta/purchase codes | P1 step 5 | `redeem-code` fn (P2) |
| Supabase project + secrets | P2 steps 1–5 | webhook + auth glue (P2) |
| Apple/Play/RevenueCat accounts, prices | P3 steps 1–4 | SDK + paywall + webhook (P3) |

Guardrails that never change, from `monetization.md`: scores are never
paywalled, sandbox until real accounts and store approval exist, clear
pricing, easy cancel, working restore.
