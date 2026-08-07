# Cadence Supabase backend

This directory holds the database schema for the future Cadence backend.
**No Supabase project exists yet** — creating one is an owner action (it
requires accepting Supabase's terms). Until then the app runs entirely on the
snapshot/fixture data in `packages/data`.

## When the owner creates a project

1. Create a Supabase organization and a **development** project (free tier).
2. Install the Supabase CLI and link it: `supabase link --project-ref <ref>`.
3. Apply migrations: `supabase db push`.
4. Put the project URL and anon key in the app environment (see `.env.example`
   at the repo root). The service-role key goes **only** into GitHub Actions
   environment secrets for ingestion jobs — never into the app.

## Layout

- `migrations/0001_core_schema.sql` — competition data: modes, segments,
  divisions, seasons, ensembles, events, sessions, performances, captions,
  awards, plus provenance (sources, ingestion runs, source records,
  corrections).
- `migrations/0002_users_and_rls.sql` — profiles, favorites, notification
  preferences, push tokens, entitlements, audit log, and Row Level Security:
  public data is world-readable, user rows are owner-only, ingestion
  bookkeeping is service-role only.

## Rules

- Migrations are append-only; never edit an applied migration.
- Every schema change is a pull request with review.
- RLS stays enabled on every table. New user-keyed tables must ship with an
  owner-only policy in the same migration.
