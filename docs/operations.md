# Operations Runbooks

What to do when something breaks. Written so the owner can follow along and the
agent can execute. General order: confirm the symptom → check the obvious log →
apply the runbook → write an incident note if users saw it.

## Runbook: legacy scrape failing

Symptom: DCI data stops updating (standings stale, update workflow red).

1. Open GitHub → Actions → **update.yml** runs. Read the failing step's log.
2. Common causes:
   - **Source page changed** (parser errors, empty results): a DCI.org or
     archive page layout changed. Fix the parser in `scraper/`, using the
     cached page in `data/raw/` to reproduce locally.
   - **Source unreachable / rate-limited:** usually transient; re-run the
     workflow. If persistent, do NOT loosen rate limits — investigate politely.
   - **Commit step failed:** often a race with another workflow; re-run.
3. While broken, the app keeps serving the last good snapshot — freshness
   badges show the old timestamp, which is the intended behavior. No emergency.
4. After fixing, re-run update.yml and verify freshness (below).

## Runbook: Pages deploy failing

Symptom: pages.yml red, or site/app not reflecting a merged change.

1. Actions → **pages.yml** → read the failing step.
2. If the failure is in the Expo export step, treat it as "app build failing"
   (next runbook).
3. If the failure is Pages infrastructure (upload/deploy steps): re-run the
   workflow; check GitHub status page for Pages incidents.
4. Remember pages.yml checks out `main` (not the trigger SHA) so data commits
   deploy fresh — a "wrong version deployed" report usually means caching;
   hard-refresh first.
5. Rollback if a bad deploy shipped: revert the offending merge on `main` (or
   check out the previous tag) and let pages.yml redeploy.

## Runbook: app build failing

Symptom: `npx expo export --platform web` fails in CI or locally, or typecheck
and tests are red.

1. Reproduce locally from the repo root:
   `npm install`, `npm run typecheck`, `npm test`, then
   `cd apps/cadence && npx expo export --platform web`.
2. Fix the first failure first — type errors often cascade into the export.
3. If a dependency update broke it, roll the dependency back in a `fix/*` PR
   and file the upgrade as separate work.
4. Never merge around a red build; `main` must always export.

## Runbook: regenerate the DCI snapshot

The app's DCI data is generated from the legacy pipeline output.

```bash
cd /path/to/Cadence-Labs
python3 scripts/gen_dci_snapshot.py
```

This reads `docs/data/` and rewrites
`packages/data/src/fixtures/dci-snapshot.json`. Then run `npm test` (snapshot
sanity is covered) and commit via a `data/*` PR. Deploys regenerate it
automatically; manual runs are for local testing or after a scraper fix.

## Runbook: check freshness

- **In the app:** every mode surfaces its provenance badge — DCI should show
  "snapshot" with a recent timestamp (the scrape runs twice daily); the other
  modes should show DEMO DATA. A DCI timestamp older than ~a day in season
  means the scrape or deploy chain is stuck.
- **At the source:** `docs/data/rankings.json` has a `generated` field; compare
  it with the latest update.yml run time.
- If `docs/data/` is fresh but the app is stale, the deploy didn't run —
  see the Pages runbook.

## Incident notes template

Keep a short note in the PR/issue that fixed the incident:

```
Incident: <one line — what users saw>
Date/duration:
Detected by: <badge / red workflow / user report>
Cause:
Fix: <link to PR/commit>
Data affected: <none / which mode, which range>
Prevention: <test added, alert added, runbook updated>
```

Feed recurring causes back into docs/threat-model.md and this file.
