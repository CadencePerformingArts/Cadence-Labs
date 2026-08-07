# ADR-001: Stage 0 Architecture — Expo + Supabase + RevenueCat Monorepo

- **Status:** Accepted (Stage 0, approved by owner)
- **Date:** 2026-08
- **Deciders:** Owner + primary AI agent

## Context

Cadence grows out of Corps Central, a Python scraper + static GitHub Pages
dashboard for DCI scores. The goal is a year-round, five-mode fan app on iOS,
Android, and web, built and maintained by a nontechnical owner working with one
AI agent, at near-zero cost until beta. Constraints that shaped the decision:

- One person effectively reviews everything; the stack must minimize moving
  parts and keep all change auditable in one place.
- No Apple/Google accounts yet; testing must work via web and Expo Go.
- The legacy scraper is valuable and keeps running; the new system must coexist
  with it, not replace it on day one.
- Future needs are known: auth (email OTP + Apple + Google), user data with
  RLS, subscriptions, store distribution, scheduled ingestion.

## Decision

1. **npm-workspaces TypeScript monorepo** — one repo, one language for app +
   domain + data + ingestion; `packages/domain` as the typed source of truth.
2. **Expo (SDK 57, Expo Router, React Native Web)** for the app — one codebase
   → iOS/Android/web; web export deploys to GitHub Pages free; EAS
   Build/Submit later for stores.
3. **Supabase (Postgres + Auth + RLS)** as the future backend; schema in
   `supabase/`, no cloud project provisioned until needed.
4. **RevenueCat** for subscription entitlements across Apple/Google/web.
5. **GitHub as the source of truth and control plane** — code, docs, data
   pipeline, CI, deploys, and the audit trail all in this repo; protected main
   + PR workflow.
6. **One primary AI agent** operating at defined autonomy levels (currently
   L2; see docs/ai-automation.md) instead of a fleet of automations.

## Alternatives considered

- **Flutter:** capable cross-platform, but Dart adds a second language next to
  the TypeScript domain/ingestion code, and its web output is a worse fit for
  a content site on Pages. Rejected for stack unity.
- **Native (Swift + Kotlin):** best-feel apps, but two codebases plus web is
  triple work for one reviewer, and requires store accounts to even test.
  Rejected on maintenance cost.
- **PWA / Capacitor:** cheapest path, but weaker push notifications on iOS and
  a wrapped-website feel; store review risk for thin wrappers. Rejected —
  Expo gives web anyway.
- **Firebase:** solid, but NoSQL fits relational score data poorly, and
  security rules are harder to audit than SQL + RLS. Postgres wins for this
  domain. Rejected.
- **Custom backend (Node + Postgres on a VPS):** maximum control, but the
  owner would own servers, auth, and backups with no team. Rejected on
  operational burden.
- **No-code (Glide/Adalo/etc.):** fastest demo, but can't express the mode
  system, comparability rules, or ingestion pipeline, and locks in a vendor.
  Rejected.

## Consequences

- One language and one repo: the agent and owner review everything in a single
  PR stream; CI (`typecheck`, `test`, web export) gates all of it.
- $0 infrastructure today; costs appear only at beta (Apple $99/yr, Google $25
  once, possibly Supabase Pro $25/mo).
- We accept Expo's constraints (native-module choices bounded by SDK 57 /
  config plugins) in exchange for EAS handling signing and store mechanics.
- Supabase/RevenueCat are vendor dependencies; mitigated by keeping the app
  behind `CadenceDataProvider` and a single entitlement flag, so either could
  be swapped behind a stable seam.
- The legacy Python pipeline remains production for DCI data until ported
  (see ADR-002) — two data mechanisms coexist deliberately during transition.
