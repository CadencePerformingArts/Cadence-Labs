# Cadence — scoreboards and workspaces for the marching & performing arts

Cadence is two products in one repository:

1. **Free public scoreboards** — live scores, season standings, event
   results, histories and favorites. **Cadence DCI** runs on real Drum Corps
   International data refreshed around the clock, and the **WGI** apps
   (Color Guard, Percussion, Winds) run on real ingested data. The WGI apps
   are siblings derived from the one proven DCI engine (ADR-003). Six other
   circuits (BOA, USBands, UIL, WGASC, TCGC, FFCC) were built and then
   retired in the August 2026 rebase; their research notes are kept under
   `data/circuit-probes/`.
2. **Paid private workspaces** — **Cadence Ensemble** ($149–499/yr, 60-day
   free trial): announcements, chat with youth-safety rules, calendar/RSVP,
   attendance, files, forms, drill — for real band and guard programs.
   Plans exist but **billing is not live yet**; no card can be charged.

**Live site:** https://cadenceperformingarts.github.io/Cadence-Labs/

## Repository map

| Path | What it is |
| --- | --- |
| `docs/` | The deployed site itself — every app, page and script |
| `scraper/`, `data/` | The data pipeline: Python scrapers that run on a GitHub Actions cron and commit real scores back to this repo |
| `supabase/` | The database — ordered SQL migrations with row-level security |
| `push-server/` | The push relay (Railway) — score notifications + the workspace notification worker |
| `scripts/` | Builders (family engine, datasets, pages, SQL bundles) and test suites |
| `.github/workflows/` | Deploy (`pages.yml`) and the scrape cron (`update.yml`, `pulse.yml`, `watch.yml`, …) |
| `apps/`, `packages/` | A parked React Native (Expo) prototype — the future native path; not published, not the product today |

## Run it locally

The site is static — serve `docs/` with anything:

```bash
python3 -m http.server 8080 --directory docs
```

then open http://localhost:8080. No accounts or keys are needed; pages that
use the database talk to Supabase with a public, RLS-safe key.

## Where the real documentation lives

- `AGENTS.md` — the contract every AI agent working here follows
- `docs/OWNER-RUNBOOK.md` — how the owner operates everything (deploys,
  migrations, notifications, launch checklist)
- `supabase/README.md` — the database: layout, deploying, testing
- `docs/decisions/` — ADRs and session reports (why things are this way)

## Data integrity & credit

Cadence publishes **real scraped data only — never fabricated scores**.
Every published number carries its source and freshness; a failed scrape
never erases the last good data. DCI scores originate from
[DCI.org](https://www.dci.org/scores) (Competition Suite),
[drum-corps.net](https://www.drum-corps.net),
[The Sound Machine](https://www.soundmachine.org/dci/dcihistory.htm) and
other credited sources. Cadence is an unofficial fan project, not
affiliated with DCI, WGI, Music for All or any circuit. Scrapers are
rate-limited and cache aggressively.
