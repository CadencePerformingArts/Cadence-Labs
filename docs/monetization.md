# Monetization

How Cadence makes money without paywalling scores or breaking trust.

## Principles

- **Scores are never paywalled.** Free users see all results, all modes.
- Cadence+ sells **depth and convenience**: analytics, richer notifications,
  history tooling, recap features.
- No dark patterns: clear pricing, easy cancel, working restore.
- Nothing is charged to anyone until real accounts, real data policies, and
  store approval exist. Until launch, everything runs in sandbox.

## Free vs. Cadence+ (feature split)

| Area | Free | Cadence+ |
| --- | --- | --- |
| Scores, standings, events, champions | All modes, full access | Same |
| Favorites | Yes | Yes |
| Notifications | Basic score alerts for favorites | Per-caption, per-rival, recap alerts, custom timing |
| Analytics | Current standings + basic deltas | Trend charts, caption breakdowns, head-to-head comparisons |
| History | Browse champions/history | Deep query and comparison tooling |
| Season recap ("Wrapped") | Teaser | Full experience |
| New modes | Available | Early access |

Pricing is deliberately not set in this document; it will be decided at launch.
Known platform costs are in the cost facts (Apple $99/yr, Google $25 once,
RevenueCat free under $2.5k monthly tracked revenue, maybe Supabase Pro $25/mo).

## Entitlements design (RevenueCat)

- One entitlement: **`plus`**. The app asks a single question — does this user
  have `plus`? — and features check that flag, never a product ID.
- Products map to the entitlement: monthly and annual subscriptions (and
  possibly a lifetime unlock later) across App Store, Play, and web billing.
  Changing products/prices never requires an app update.
- RevenueCat is the source of truth for entitlement state; the `entitlements`
  table in Supabase mirrors it (via webhook) so server-side features and
  support can see status. **The client is never trusted** to assert
  entitlement: RevenueCat validates receipts server-side.
- Offerings/paywalls are configured in the RevenueCat dashboard so experiments
  don't need releases.

## Platform billing

- **iOS:** StoreKit via RevenueCat SDK. Requires the Apple Developer account
  and signed Paid Applications agreement (owner-only actions).
- **Android:** Play Billing via RevenueCat SDK. Requires the Play Console
  account.
- **Web:** RevenueCat Web Billing (Stripe-backed) later, so the web app can
  subscribe without app-store fees where policy allows.

## Sandbox until launch

Until public launch, all purchases run in sandbox/test modes only: StoreKit
sandbox testers, Play license testers, RevenueCat sandbox environment. No real
charges. CI and demo builds never contain production store keys.

## What requires owner accounts (agent cannot do these)

- Creating the Apple Developer and Google Play accounts; signing the paid-apps
  agreements; banking and tax forms.
- Creating the RevenueCat account and connecting store credentials.
- Setting real prices and submitting in-app purchases for review.
- Accepting any platform terms.

The agent can prepare everything up to those buttons: SDK integration,
entitlement checks, paywall UI, sandbox test plans, and store metadata drafts.

## Refunds, grace, restore

- **Refunds:** handled by Apple/Google per their policies; RevenueCat webhooks
  revoke the entitlement automatically. We don't fight refunds.
- **Billing grace period:** enabled on both stores; a failed renewal keeps
  `plus` active through the grace window rather than cutting off mid-season.
- **Restore purchases:** a visible "Restore purchases" button is mandatory
  (Apple requires it) and RevenueCat restore is wired on all platforms.
  Signing in on a new device restores entitlement via the same identity.
- **Cancellation:** links straight to the platform's manage-subscription page;
  access continues to the end of the paid period.
