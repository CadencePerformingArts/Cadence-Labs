# Data Model

Two layers: the TypeScript domain model the app uses today, and the target
Supabase (Postgres) schema it will be backed by. The TS model is the contract;
the SQL schema serves it.

## Current TypeScript domain model

Defined in `packages/domain/src/types.ts`:

- **Mode structure:** `ModeDefinition` → `Segment` → `Division` (+
  `ScoreSystem`, `Terminology`) — static configuration, shipped in code, not
  in the database. See docs/mode-system.md.
- **Results:** `CompetitionEvent` → `Session` (round) → `Performance` (one
  ensemble's result: score or points, rank, `CaptionScore[]`, awards, penalty,
  advanced).
- **Entities:** `Ensemble` (with `aliases` for name variations over time).
- **Derived:** `Standings` / `StandingRow` (season leaderboard with trend
  points), `ChampionEntry` (title history).
- **Provenance:** every `Standings` (and, in the target schema, every result)
  carries `Provenance { sourceId, sourceName, url?, fetchedAt, kind }` where
  kind is `live | snapshot | fixture`. Nothing renders without knowing where it
  came from and how fresh it is.

Data reaches the app only through `CadenceDataProvider`
(`packages/data/src/provider.ts`); today `FixtureProvider` serves it, later
`SupabaseProvider` will, unchanged from the UI's point of view.

## Target Supabase schema

Migrations live in `supabase/` (schema ready; no cloud project provisioned yet).

### Competition data (public read, written only by ingestion)

| Table | Purpose |
| --- | --- |
| `organizations` | Circuits/governing bodies (DCI, WGI, Music for All, Varsity Vocals, individual show choir hosts). |
| `seasons` | A season of a mode/segment (e.g. DCI 2026), with start/end dates. |
| `events` | Competitions: name, date, venue, city, region, timezone, season. |
| `sessions` | Rounds within an event (Prelims/Semis/Finals), ordered. |
| `performances` | One ensemble in one session: score/points, rank, penalty, advanced. |
| `scores` | Score values keyed to a `scoring_system` version (see below). |
| `captions` | Caption-level subscores per performance (GE, Visual, Music, ...). |
| `awards` | Named awards per event/session (Grand Champion, Best Vocals, ...). |
| `ensembles` | Canonical ensembles with home location and division history. |
| `aliases` | Alternate names → canonical ensemble ("The Cadets" / "Cadets"). |
| `sources` | Registered data sources with terms status and attribution text. |
| `ingestion_runs` | Every pipeline run: source, timings, counts, diff summary, outcome. |

### User data (RLS: each user sees only their own rows)

| Table | Purpose |
| --- | --- |
| `profiles` | App profile keyed to the auth user. |
| `favorites` | Followed ensembles/events per user (currently on-device only). |
| `notification_prefs` | What to push, per mode/ensemble. |
| `entitlements` | Mirror of RevenueCat entitlement state (free / Cadence+). |
| `audit_log` | Append-only record of privileged/admin actions. |

## Cross-cutting rules

- **Time:** all timestamps stored as UTC (`timestamptz`). Events additionally
  store their IANA timezone so "7:00 PM at the stadium" renders correctly; the
  domain model's event `date` is the event's local date.
- **Versioned scoring systems:** circuits change sheets (caption weights, max
  values) between seasons. Scores reference a `scoring_system` row with a
  version/effective season, so historical scores are never reinterpreted under
  new rules and cross-era comparisons stay honest.
- **Provenance on every result:** each performance/score row links to its
  `sources` row and the `ingestion_runs` row that wrote it, with fetched-at.
  The app's freshness badges derive from this, so "live vs snapshot vs demo"
  is data, not vibes.
- **Corrections, not overwrites:** when a circuit amends a score, ingestion
  writes a new versioned value and the run's diff records it; the previous
  value stays recoverable (see docs/ingestion.md).
- **Comparability is enforced in the domain layer,** not the database: queries
  return raw rows; `packages/domain` decides what may share a table.

## Mapping old → new

The legacy pipeline's `docs/data/*.json` (rankings, seasons, champions,
upcoming) maps onto `events`/`sessions`/`performances`/`captions` plus derived
standings. `scripts/gen_dci_snapshot.py` already performs a small version of
this mapping into the app's snapshot; porting it into `packages/ingestion`
writing to Postgres is the plan of record
(`docs/decisions/ADR-002-data-plane-separation.md`).
