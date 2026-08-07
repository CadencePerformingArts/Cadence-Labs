# Cadence — Architecture

Cadence is an npm-workspaces TypeScript monorepo with one Expo app, four shared
packages, a database schema folder, and a legacy Python pipeline that still
produces the real DCI data.

## Monorepo layout

```
Cadence-Labs/
├── apps/cadence/          Expo SDK 57 app (Expo Router, React Native Web)
├── packages/
│   ├── domain/            Typed mode registry + comparability rules + tests
│   ├── ui/                Navy/gold design system (light + dark)
│   ├── data/              CadenceDataProvider interface + FixtureProvider
│   └── ingestion/         Source adapter interfaces + contract tests (early)
├── supabase/              SQL migrations + RLS (schema ready; no cloud project yet)
├── scraper/               LEGACY Python scrapers (Corps Central) — still live
├── docs/                  LEGACY static site (GitHub Pages) + docs/data/ JSON
│                          ...and these markdown docs
├── scripts/gen_dci_snapshot.py   docs/data/ → packages/data DCI snapshot
└── .github/workflows/     update.yml (scrape 2x daily), pages.yml (deploy)
```

## Package responsibilities

- **packages/domain** — the source of truth for what each activity *is*:
  `ModeDefinition`, `Segment`, `Division`, score systems, terminology, and the
  comparability rules that decide which divisions may share a ranked table.
  No I/O, no React. Tests in `src/__tests__/`.
- **packages/ui** — themed components (light + dark), the navy/gold shell, and
  `FreshnessBadge`, which renders provenance (live / snapshot / DEMO DATA).
- **packages/data** — `CadenceDataProvider`, the single seam between the app and
  its data (`provider.ts`). Today `FixtureProvider` serves the real DCI snapshot
  plus labeled fixtures for the other modes. A future `SupabaseProvider`
  implements the same interface; the UI does not change.
- **packages/ingestion** — interfaces and contract tests for source adapters.
  This is where the legacy scraper logic gets ported (see below).
- **apps/cadence** — screens only. Expo Router file-based routes under
  `src/app/`: tabs (scoreboard, events, ensembles, favorites, more), plus
  ensemble/event detail and the mode switcher. Ships to iOS, Android, and web.

## Data flow today

```
 DCI.org / archives                (other modes)
        │                               │
        ▼                               ▼
 scraper/*.py  (2x daily,        hand-built fixtures
 GitHub Actions update.yml)      packages/data/src/fixtures/*.ts
        │                               │
        ▼                               │
 docs/data/*.json  ──────────┐          │
 (legacy site reads this)    │          │
        │                    ▼          │
        │      scripts/gen_dci_snapshot.py
        │                    │          │
        │                    ▼          ▼
        │        packages/data FixtureProvider
        │                    │
        ▼                    ▼
 GitHub Pages /        apps/cadence  →  Pages /app/
 (old Corps Central)   (Expo web export; also iOS/Android via Expo Go)
```

Every result carries `Provenance` (source, fetch time, kind: live / snapshot /
fixture), and the UI badges it accordingly.

## Why these choices

- **Expo (React Native + Web).** One TypeScript codebase for iOS, Android, and
  web; the web build deploys to GitHub Pages for free, and phones can test via
  Expo Go with no Apple/Google accounts. EAS handles store builds later.
- **Supabase (Postgres).** A real relational database fits scores (events →
  sessions → performances → captions) far better than JSON files; Row Level
  Security protects user tables; auth (email OTP, Apple, Google) is built in.
  Free tier is enough until beta.
- **RevenueCat.** Cross-platform subscription entitlements (Apple + Google +
  web) without writing receipt-validation servers. Free under $2.5k monthly
  tracked revenue.

Full rationale and alternatives: `docs/decisions/ADR-001-architecture.md`.

## Legacy pipeline: coexistence and porting plan

The Python scraper in `scraper/` is not deprecated dead weight — it is the
production source of real DCI data and keeps running unchanged:

1. **Now:** `update.yml` scrapes twice daily → `docs/data/` → old site, and
   `gen_dci_snapshot.py` folds the same data into the app at each web deploy.
2. **Next:** the scraper's fetch/parse logic is ported adapter-by-adapter into
   `packages/ingestion` (TypeScript), writing to Supabase Postgres instead of
   committed JSON, with contract tests locking in parsing behavior.
3. **Then:** the app switches from `FixtureProvider` to `SupabaseProvider` for
   DCI; the old site can keep running as long as it is useful.

The data plane's move out of git is recorded in
`docs/decisions/ADR-002-data-plane-separation.md`.

## Checks that must always pass

- `npm run typecheck` — tsc across domain, data, ui, app.
- `npm test` — vitest, 23+ tests (registry, comparability, provider, freshness).
- `npx expo export --platform web` in `apps/cadence` — the web build.
