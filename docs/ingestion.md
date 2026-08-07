# Ingestion Pipeline

How competition data gets from a source into the app, reliably, without ever
lying about freshness. Today this describes the legacy Python pipeline's
behavior plus the design that `packages/ingestion` implements as adapters are
ported to write to Postgres.

## Stages

Every adapter run flows through the same stages:

```
fetch → parse → validate → normalize → alias resolution → diff → upsert → publish → notify
```

1. **Fetch** — rate-limited, cached HTTP (the legacy pipeline keeps a gzipped
   page cache in `data/raw/` so reruns never refetch history). Respect robots
   and terms (docs/data-sources.md).
2. **Parse** — source-specific extraction from HTML/PDF/JSON into raw records.
3. **Validate** — sanity checks before anything else sees the data: scores
   within the score system's max/precision, ranks consistent, dates plausible,
   required fields present. Invalid batches are rejected, not "fixed".
4. **Normalize** — map to the domain model: events, sessions, performances,
   captions, with UTC timestamps and event timezones.
5. **Alias resolution** — map source spellings to canonical ensembles via the
   `aliases` table ("Blue Devils A" vs "Blue Devils"). Unknown names create a
   review item, not a silent new ensemble.
6. **Diff** — compare against what is already stored: new results, changed
   scores (corrections), removed rows. The diff is recorded on the run.
7. **Upsert** — idempotent writes keyed by natural identity (event + session +
   ensemble). Corrections write a new versioned value; nothing is destroyed.
8. **Publish** — mark the batch visible to the app and stamp provenance
   (source, fetched-at, kind).
9. **Notify** — only after publish: push notifications for followed ensembles,
   freshness metadata updated.

## Properties the pipeline guarantees

- **Idempotency.** Running the same adapter twice over the same source state
  produces zero diff. Safe to retry, safe to re-run after a crash.
- **Last-good-data retention.** A failed run never clobbers good data. The app
  keeps serving the last published state; failures only show up as staleness
  (and the freshness badge tells the truth about it).
- **Corrections tracked, not overwritten.** Circuits amend scores. A
  correction appears in the run diff, the old value remains recoverable, and a
  notification can say "score corrected" rather than pretending it was always so.
- **Every run recorded.** `ingestion_runs` stores source, start/end, counts,
  diff summary, and outcome — the first place to look when something is off
  (docs/operations.md).

## Contract tests and schema-change detection

- Each adapter ships **contract tests** in `packages/ingestion`: saved sample
  pages/payloads with the exact expected parse output. Parsers can be
  refactored fearlessly; the contract locks behavior.
- **Schema-change detection:** when a source page stops matching expectations
  (selector misses, field counts change, validation failure rate spikes), the
  run fails loudly instead of ingesting garbage. A failing contract test or
  validation gate is the alarm, and last-good-data retention contains the blast.

## Cadence (how often it runs)

- **In season:** frequent — the legacy DCI scrape runs twice daily; live
  adapters may run more often around show nights and championships.
- **Off-season:** slow — weekly or on-demand; sources barely change, and being
  a polite guest matters more than freshness.
- Schedules live in GitHub Actions (deterministic automation — see
  docs/ai-automation.md), later potentially in Supabase scheduled functions.

## Independence from app deploys

The data plane and the app deploy are separate:

- The scraper updates `docs/data/` on its own schedule regardless of app
  releases; the app snapshot is regenerated from it at each web deploy.
- Once Supabase is live, data updates reach users with **no deploy at all** —
  the app reads the database. Rolling back an app release never rolls back
  data, and a data problem never requires shipping an app build.

See `docs/decisions/ADR-002-data-plane-separation.md` for the rationale.
