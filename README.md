# Cadence — the year-round scoreboard for the marching & performing arts

Cadence is a fan app for competitive musical performing arts: live scores,
season standings, event results, histories and favorites — across five modes
with one account, one design system and one navigation shell:

1. 🥁 **DCI** (Drum Corps International) — running on real 2026 season data
2. 🚩 **WGI** (Color Guard · Percussion · Winds)
3. 🎺 **Bands of America**
4. 🎤 **Competitive A Cappella** (ICCA / ICHSA / The Open)
5. 🎭 **Show Choir**

**Try it in a browser:** https://cadenceperformingarts.github.io/Cadence-Labs/
**Legacy DCI dashboard:** https://cadenceperformingarts.github.io/Cadence-Labs/

WGI, BOA, A Cappella and Show Choir currently run on clearly-labeled
demonstration fixtures; DCI runs on a real snapshot refreshed from the
scraping pipeline. See `docs/data-sources.md`.

## Run it locally

```bash
npm install
npm run web          # web dev server
npm run app          # Expo dev server — scan the QR with Expo Go (iOS/Android)
npm test             # unit + contract tests
npm run typecheck
```

No paid accounts, API keys or app-store memberships are needed to develop or
test. Native store builds (EAS), Supabase accounts and RevenueCat come later —
see `docs/store-readiness.md` and `supabase/README.md`.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/cadence` | Expo app — iOS, Android and web from one TypeScript codebase |
| `packages/domain` | Mode registry, score comparability rules, shared types |
| `packages/ui` | Cadence design system (navy/gold, light + dark) |
| `packages/data` | Data provider interface, fixtures, real DCI snapshot |
| `packages/ingestion` | Source adapters + contract tests |
| `supabase/` | Database schema + Row Level Security (awaiting provisioning) |
| `docs/*.md` | Product, architecture, security and operations docs |
| `scraper/`, `data/`, `docs/` (site) | **Legacy Corps Central pipeline** — Python scrapers + the original DCI dashboard, still running on cron and feeding real data |
| `.github/workflows` | CI (`app-ci.yml`), site deploy (`pages.yml`), legacy scrape jobs |

Architecture decisions are recorded in `docs/decisions/`. Rules for AI agents
working here are in `AGENTS.md`.

## Data & credit

DCI scores originate from [DCI.org](https://www.dci.org/scores) (Competition
Suite), [drum-corps.net](https://www.drum-corps.net),
[The Sound Machine](https://www.soundmachine.org/dci/dcihistory.htm) and
other credited sources. Cadence is an unofficial fan project, not affiliated
with DCI, WGI, Music for All, Varsity Vocals or any circuit. Scrapers are
rate-limited and cache aggressively; every published number carries its
source and freshness.
