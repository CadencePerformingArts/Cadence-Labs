# Release Checklist

Run this top to bottom before tagging a release. Anything red stops the
release — no exceptions, no "we'll fix it after".

## Pre-release checks

- [ ] `npm install` clean on a fresh clone (lockfile honest).
- [ ] `npm run typecheck` passes (domain, data, ui, app).
- [ ] `npm test` passes — all vitest suites (23+ tests), none skipped.
- [ ] `npx expo export --platform web` succeeds in `apps/cadence`.
- [ ] DCI snapshot is fresh: `docs/data/rankings.json` `generated` timestamp is
      recent, and `scripts/gen_dci_snapshot.py` has been run if data changed
      (docs/operations.md).

## Manual pass (screenshots required)

Take screenshots on at least **3 modes** — always DCI plus two others — in
light and dark, and attach them to the release PR/tag notes:

- [ ] **DCI:** real standings render with trends; provenance badge says
      snapshot with a current timestamp; champions timeline loads.
- [ ] **Two fixture modes** (rotate among WGI / BOA / A Cappella / Show Choir):
      screens render with correct terminology and divisions.
- [ ] **Freshness labels correct everywhere:** DEMO DATA badge on all four
      fixture modes, snapshot badge on DCI, nothing claiming "live".
- [ ] Mode switcher, favorites, event detail, and ensemble detail all work.
- [ ] WGI activity names read Color Guard / Percussion / **Winds**.
- [ ] No template/debug artifacts visible.

## Tagging

- [ ] `main` is green and contains everything intended for the release.
- [ ] Tag: `git tag -a vX.Y.Z -m "<one-paragraph user-visible summary>"` then
      `git push origin vX.Y.Z`. Bump minor for features, patch for fixes.
- [ ] Release notes (GitHub Release): plain-English changes, screenshots,
      known issues.

## Pages verification (post-deploy)

- [ ] pages.yml run for the release commit is green.
- [ ] Old site loads at `/` (Corps Central unaffected).
- [ ] App loads at `/app/` — hard-refresh to defeat caching.
- [ ] Spot-check DCI standings and one fixture mode on the deployed app,
      including the badges.
- [ ] Mobile check via Expo Go (`npm run app`) if anything platform-sensitive
      changed.

## Rollback (if the release is bad)

Revert the offending merge on `main` (or redeploy the previous tag) and let
pages.yml redeploy — see docs/development-workflow.md. Note the incident
(docs/operations.md template).

## Future: store releases (once accounts exist)

These steps activate when EAS/TestFlight/Play are live (docs/store-readiness.md):

- [ ] EAS **preview** build installed and smoke-tested on a real iPhone and
      Android device.
- [ ] TestFlight internal testers pass the manual checklist above on device.
- [ ] Play internal testing track: same.
- [ ] Privacy checklist re-reviewed if any data handling changed
      (docs/privacy-checklist.md); store questionnaires still accurate.
- [ ] Review notes updated (docs/store-readiness.md template).
- [ ] EAS **production** build → Submit → phased release enabled.
- [ ] Post-approval: verify the store listing, then tag as above with the
      store build numbers in the notes.
