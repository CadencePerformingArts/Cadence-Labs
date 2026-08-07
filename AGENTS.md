# Instructions for AI agents working in this repository

Cadence is a year-round scoreboard and fan app for competitive musical and
performing arts (DCI, WGI, Bands of America, Competitive A Cappella, Show
Choir). This file is the contract every AI agent follows here.

## Repository map

- `apps/cadence` — Expo SDK 57 app (Expo Router, TypeScript). iOS, Android
  and web from one codebase. Screens live in `src/app/`, global mode state in
  `src/state/ModeContext.tsx`.
- `packages/domain` — the typed mode registry (`src/modes/*.ts`), score
  comparability rules (`src/comparability.ts`), shared types. **Mode
  definitions live here and only here.**
- `packages/ui` — Cadence design system (navy `#0a3f6b` / gold `#f0b429`,
  light + dark). Reusable components only; no data fetching.
- `packages/data` — `CadenceDataProvider` interface, `FixtureProvider`,
  fixtures, local favorites/prefs storage. The DCI snapshot
  (`src/fixtures/dci-snapshot.json`) is **generated** by
  `scripts/gen_dci_snapshot.py` — edit the generator, not the JSON.
- `packages/ingestion` — source adapter interfaces and contract tests.
- `supabase/` — SQL migrations + RLS. Append-only; never edit an applied
  migration.
- `scraper/`, `data/`, `docs/` (non-`.md` files), `push-server/`, legacy
  workflows (`update.yml`, `backfill.yml`, `watch.yml`, …) — the **legacy
  Corps Central pipeline that feeds real DCI data**. It runs on cron. Do not
  break it; coordinate changes carefully.
- `docs/*.md`, `docs/decisions/` — documentation and ADRs.

## Commands that must pass before any push

```bash
npm run typecheck   # tsc across all packages + app
npm test            # vitest: domain rules, fixtures, ingestion contracts
cd apps/cadence && npx expo export --platform web   # web build
```

## Data rules — never violate these

1. **Never present fixture data as live.** WGI/BOA/A Cappella/Show Choir run
   on fixtures labeled `kind: 'fixture'` and the UI shows a DEMO DATA badge.
   Do not change a mode's `dataStatus` without a real, permitted source.
2. **Never compare incomparable scores.** Divisions share a ranked table only
   when they share a `comparabilityGroup`. DCI All-Age never ranks against
   World Class; WGI classes never combine. Tests enforce this — keep them.
3. **Every published result needs provenance** (source, URL, fetchedAt, kind).
4. **A failed scrape must never erase last good data.** Upserts only; no
   blind overwrites.
5. **Never bypass authentication, bot protection, or rate limits** on any
   source. WGI, Music for All and Varsity Vocals require terms review before
   any live adapter is written.
6. WGI's third activity is **Winds**, never "Brass".

## Workflow rules

- Work on branches (`feature/*`, `fix/*`, `data/*`, `agent/*` or a
  designated `claude/*` branch). Never force-push `main`.
- One agent per branch. Never work on a branch another agent has open.
- Keep the legacy pipeline green: its workflows commit scraped data to `main`
  on cron. Don't create commit races with it; rebase/pull before pushing main.
- Auth, billing, security and migration changes always need human approval.
- Never commit secrets. App-safe config uses `EXPO_PUBLIC_*`; the Supabase
  service-role key lives only in GitHub environment secrets.
- Never enable real billing, submit to app stores, purchase anything, or
  create cloud infrastructure without explicit owner authorization.
- Record significant architecture decisions as ADRs in `docs/decisions/`.

## Adding a mode

See `docs/adding-a-mode.md`: a mode definition in `packages/domain/src/modes/`,
fixtures in `packages/data/src/fixtures/`, registration in `registry.ts`,
tests, and optionally mode-specific screens. The shell (tabs, switcher,
favorites, theming) comes free.
