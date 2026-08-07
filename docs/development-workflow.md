# Development Workflow

How code gets from an idea to the live site, in a way a nontechnical owner can
supervise.

## Branches

Work never happens directly on `main` (except owner-authorized merges during the
current bootstrap phase — see docs/ai-automation.md). Branch names say what kind
of change is inside:

- `feature/<short-name>` — new functionality (e.g. `feature/wgi-scoreboard`).
- `fix/<short-name>` — bug fixes.
- `data/<short-name>` — data, fixtures, or snapshot changes.
- `agent/<short-name>` — changes authored autonomously by an AI agent.

## Pull request flow

1. Branch off `main`, make the change, keep it focused (one topic per PR).
2. Open a PR with a plain-English description: what changed, why, how to see it,
   and any risk. Screenshots for anything visual.
3. Required checks run automatically and must pass:
   - `npm run typecheck`
   - `npm test` (vitest, 23+ tests)
   - `npx expo export --platform web` (the app must still build)
4. Review, approve, merge (squash preferred — one clean commit per PR).
5. Merge to `main` triggers the Pages deploy: old site at `/`, app at `/app/`.

## How the owner reviews (no coding required)

- **Read the PR description.** It should tell you in plain English what changed
  and why. If it doesn't, ask for a better description — that's a valid review.
- **Look at the checks.** Green checkmarks mean typecheck, tests, and the web
  build all passed. Red means don't merge.
- **Click the preview / try the result.** For visual changes, screenshots are in
  the PR; after merge, verify at the Pages URL (`/app/`). Locally:
  `npm install && npm run app`, then open in Expo Go.
- **Sanity questions to ask every time:** Does demo data still show the DEMO
  DATA badge? Does DCI still show real standings? Do the tab names still use
  the right vocabulary for each mode?
- **Approve or request changes.** You never need to read the code.

## Environments (today and future)

- **Today:** merge to `main` deploys straight to GitHub Pages (production for
  the web preview). Expo Go serves as the mobile "environment".
- **Planned progression:** merge → **staging** (a staging Supabase project +
  preview deploy) → manual promote → **production**. Store builds go through
  TestFlight / Play internal testing before public release.

## Releases and rollback

- Tag releases on `main`: `v0.1.0`, `v0.2.0`, ... (semantic-ish: bump minor for
  features, patch for fixes). The tag message summarizes user-visible changes.
- Run the release checklist first: `docs/release-checklist.md`.
- **Rollback = redeploy the previous tag.** Because deploys are built from git,
  reverting is checking out the last good tag and re-running the Pages deploy
  (or `git revert` of the bad merge on `main`). No data is lost: the data plane
  (scraper output, later Supabase) is independent of app deploys.

## Ground rules

- `main` is protected (see docs/security.md): PRs + passing checks required.
- The scheduled scraper commits data to `main` on its own; that is the one
  standing exception, limited to `docs/data/` paths.
- Never merge a red PR "to fix it later".
- Data changes and code changes ride in separate PRs when practical, so a data
  problem never forces a code rollback or vice versa.
