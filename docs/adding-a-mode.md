# Adding a Mode

How to add a sixth (seventh, ...) activity to Cadence. The mode system is
designed so most of the app comes free; the work is defining the activity
correctly, not building screens.

## Step 1 — Define the mode

Create `packages/domain/src/modes/<modeid>.ts` exporting a `ModeDefinition`
(copy the closest existing mode as a starting point — `wgi.ts` for multi-
segment, `boa.ts` for event-based, `acappella.ts` for tournaments):

1. Add the new id to the `ModeId` union in `packages/domain/src/types.ts`.
2. Define `ScoreSystem`s (max, precision, score vs points).
3. Define `Segment`s with `Division`s. Get **comparabilityGroup** right — this
   is the most important decision in the file. Ask: "would ranking these two
   divisions in one table be competitively meaningful?" If no, different
   groups. When unsure, keep them separate; merging later is safe, unmerging
   is a correction.
4. Pick `rankingBehavior` per segment: `seasonLeaderboard` (a season-long
   table makes sense), `eventBased` (results only mean something per event),
   or `tournament` (rounds/regions/advancement).
5. Fill `terminology` with the activity's real vocabulary (what is an
   ensemble called? an event? the results surface?).
6. Set `screens`, `features`, `icon`, `accent`, `tagline`, `emptyState`.
7. Set `dataStatus: 'fixture'` and an honest `dataSourceNote`. New modes always
   start as fixtures.

## Step 2 — Fixtures

Create `packages/data/src/fixtures/<modeid>.ts` using
`packages/data/src/fixtures/helpers.ts`:

- Real ensemble names, plausible events — **invented scores**. Fixtures must
  look like the activity actually looks (right divisions, right rounds, right
  score precision) so screens exercise real shapes.
- Provenance kind must be `fixture` so the DEMO DATA badge appears.
- Wire the fixture set into `FixtureProvider`
  (`packages/data/src/fixtureProvider.ts`).

## Step 3 — Register

Add the mode to the registry in `packages/domain` (see how the five existing
modes are exported/registered) so the mode switcher and provider can find it.

## Step 4 — Tests

Extend the existing suites — CI requires them:

- `packages/domain/src/__tests__/registry.test.ts`: the mode is registered,
  default segment/divisions exist, screens and terminology are populated.
- `packages/domain/src/__tests__/comparability.test.ts`: assert which division
  pairs may and may not combine — encode the judgment from step 1.3 as tests.
- Provider tests in `packages/data/src/__tests__`: fixtures load, provenance is
  `fixture`, standings/events/ensembles come back for the new mode.

Run `npm run typecheck` and `npm test`; both must pass.

## What comes free vs. mode-specific work

**Free once registered:** the mode appears in the switcher; scoreboard, events,
ensembles, favorites, and more tabs render with the mode's terminology, accent,
divisions, and DEMO DATA badge; event and ensemble detail pages work; favorites
work.

**Mode-specific work (only if needed):** a genuinely new ranking presentation
(e.g. a bracket view for a new tournament style), new feature flags in
`ModeFeatures`, custom visualizations. Prefer extending the generic screens
over forking them.

## Step 5 — Source adapter (later, separately)

Going from fixture to real data is its own project, gated by the sourcing
ladder in docs/data-sources.md:

1. Research candidate sources and complete a terms review.
2. Build an adapter in `packages/ingestion` with contract tests
   (docs/ingestion.md).
3. Only when real data flows end-to-end, flip `dataStatus` and update
   `dataSourceNote` with attribution.

Never flip `dataStatus` off `fixture` as part of adding the mode.
