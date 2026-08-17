# Cadence Supabase backend

This directory holds the database schema for Cadence — both the public
accounts layer (profiles, favorites, preferences, Cadence+ entitlements,
Ensemble Pro claims, analytics) and the private Cadence Ensemble workspace
system (organizations, roles, comms, calendar, files, drill, billing).

A live Supabase project backs the deployed site. Its URL and **publishable**
key ship in `docs/supabase.js` — that is safe by design, because every table
is guarded by Row Level Security. The **service-role** key must never appear
in the repo or the client bundle; it belongs only in a trusted server
environment (edge functions / CI secrets).

## Layout

Migrations are ordered and append-only (`0001` … `0013`). Never edit an
applied migration — correct it with a new one.

- `0001_accounts_foundation.sql` — profiles, favorites, preferences,
  `plus_entitlements` (service-role-write-only), Ensemble Pro `claims`
- `0002_stripe_fulfillment.sql` — `plus_pending` and the webhook helper
- `0003_usage_analytics.sql` — self-owned `usage_events`
- `0004_ensemble_pro.sql` — claim-gated public `ensemble_profiles`
- `0005_ensemble_core.sql` — organizations, roles, members, groups, seasons,
  invites, access requests, audit log; the RLS helper functions
  (`is_org_member`, `org_has_perm`, `org_can_write`, `org_member_id`) and the
  seed trigger that provisions a new org
- `0006_ensemble_comms.sql` — posts (with acknowledgments), chats/messages
  with youth-safety DM rules, notification prefs, realtime publication
- `0007_ensemble_ops.sql` — events, RSVPs, attendance, itineraries, packing
  lists, signups (atomic claim + waitlist), tasks, polls
- `0008_ensemble_files.sql` — folders, files, favorites, the private
  `ensemble` storage bucket, quota triggers
- `0009_ensemble_people.sql` — guardians, forms (incl. medical), invoices
- `0010_harden_grants.sql` — advisor-pass fixes to function grants
- `0011_drill.sql` — drill shows / performers / sets and dot-claim RPCs
- `0012_security_hardening.sql` — the seven-vulnerability fix pass
  (role-escalation guard, same-org roles, storage accounting, invite
  atomicity, drill-dot ownership, youth-safety-by-participant, analytics
  identity) plus the 0006 grant-drift repair
- `0013_event_chats.sql` — links a chat to an event, `open_event_chat` RPC

`RUN_ALL.sql` and `RUN_ENSEMBLE.sql` are **generated** paste-and-run bundles
(one transaction each). Regenerate them after adding a migration:

```
python3 scripts/gen_sql_bundles.py
```

## Deploying migrations

Two paths, both owner-run — nothing here deploys automatically:

- **Fresh project:** paste `RUN_ALL.sql` into the Supabase SQL editor.
- **Existing project:** apply the new migration file(s) in order, or paste
  `RUN_ENSEMBLE.sql` when only the workspace layer is missing.

Storage object policies for the private `ensemble` bucket are created by
`0008` where the SQL role has the privilege; on projects where it does not,
`0008` prints a notice and the four policies must be added once in the
dashboard (Storage → Policies). See `docs/ensemble/SETUP.md`.

## Testing before you deploy

`scripts/test_db_security.py` boots a disposable PostgreSQL, applies
`RUN_ALL.sql`, seeds cross-tenant personas, and replays the adversarial
attacks the hardening migrations close — proving both a fresh apply and an
additive upgrade from the prior schema. Run it after any migration change.
It **never** touches a real project.

## Rules

- Migrations are append-only; never edit an applied one.
- RLS stays enabled on every table; new member-keyed tables ship with a
  policy in the same migration.
- Writes involving money, roles, or capacity go through guarded RPCs or
  service-role-only columns — never a trusted client PATCH.
- The service-role key never enters the repo or the browser bundle.
