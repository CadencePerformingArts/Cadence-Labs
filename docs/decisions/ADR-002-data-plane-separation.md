# ADR-002: Separate the Data Plane from Git

- **Status:** Accepted (direction) — interim mechanism in production, target
  mechanism pending Supabase provisioning
- **Date:** 2026-08
- **Deciders:** Owner + primary AI agent

## Context

The legacy Corps Central pipeline commits its output — `docs/data/*.json` and
the gzipped page cache — into this git repository, and GitHub Pages serves the
JSON directly. That was a great choice for a static dashboard: free hosting,
history for free, zero servers. It scales poorly for the app's future:

- Every scrape is a commit; twice-daily data churn pollutes history and races
  with code merges and deploys (pages.yml already works around one such race).
- Users only get new data when a deploy ships; data freshness is coupled to
  the app release cycle.
- JSON files can't serve per-user features (favorites sync, notifications),
  row-level security, or efficient queries across five modes of history.
- Repo size grows without bound as caches and seasons accumulate.

## Decision

Move competition data out of git-committed JSON and into Supabase Postgres,
written by ingestion adapters in `packages/ingestion` and read by the app
through a `SupabaseProvider` implementing the existing `CadenceDataProvider`
interface.

**Interim mechanism (in production now):** keep the legacy pipeline exactly as
is, and generate the app's DCI data as a build-time snapshot —
`scripts/gen_dci_snapshot.py` reads `docs/data/` and writes
`packages/data/src/fixtures/dci-snapshot.json`, regenerated on each web deploy
so it tracks the twice-daily scrape. The snapshot carries provenance kind
`snapshot` with its capture timestamp, so the app never overstates freshness.

## Migration path

1. **Now:** scraper → `docs/data/` → snapshot at deploy time (this ADR's
   interim state).
2. Provision Supabase; apply the schema in `supabase/` (see docs/data-model.md).
3. Port the DCI adapter into `packages/ingestion` (TypeScript, contract
   tests), writing to Postgres on a schedule; run it in parallel with the
   legacy pipeline and diff the outputs until they agree.
4. Switch the app's DCI mode to `SupabaseProvider`; provenance kind becomes
   `live`. The old site may keep consuming `docs/data/` as long as it exists.
5. New modes (WGI, BOA, A Cappella, Show Choir) go straight to
   ingestion→Postgres when their sources clear terms review — they never get a
   git-committed data stage.

## Consequences

- **Positive:** data updates decouple from app deploys (results reach users
  with no release); per-user features and RLS become possible; queries and
  storage scale; app rollbacks never roll back data and vice versa
  (docs/ingestion.md).
- **Negative / accepted:** a database becomes a runtime dependency with its
  own availability, backups, and (eventually ~$25/mo Pro) cost; data history
  moves from "free via git" to `ingestion_runs` + database backups, which we
  must actually operate (docs/security.md).
- **Interim cost:** until step 4, DCI data in the app is point-in-time rather
  than live, and still rides through git. This is acceptable because the
  snapshot is regenerated twice daily with honest provenance labeling.
- The `CadenceDataProvider` seam is the load-bearing abstraction: the UI is
  unaffected by the entire migration.
