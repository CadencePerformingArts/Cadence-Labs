# ADR-003 — Cadence is a family of apps derived from the DCI engine

**Date:** 2026-08-07 · **Status:** accepted · **Supersedes:** the app-shell
direction of ADR-001 for the near term (the Expo build remains parked at
`/app/` as the future native path).

## Decision

The product is a **family of sibling web apps**, one per activity, each an
instance of the proven DCI dashboard engine:

- The original dashboard is branded **Cadence DCI** and is otherwise
  untouched — it keeps its live pipeline, notifications, PWA install and all
  features.
- `scripts/build_family_engine.py` derives `docs/family/app.js` from
  `docs/app.js` via **asserted transforms** (config-driven class systems,
  terminology, namespaced storage, per-class notification preferences,
  no captions tab). If `app.js` drifts, the build fails loudly. DCI
  improvements therefore flow into every family app automatically at each
  deploy.
- `scripts/gen_family_data.py` emits each instance's dataset **in the exact
  DCI pipeline format** (rankings/seasons/corps_index/corps/profiles/
  champions/records/db/meta). Today these are labeled demo seasons; a mode
  goes live by replacing its generator with a real adapter writing the same
  format — nothing else changes.
- `scripts/gen_family_pages.py` emits each instance's `index.html` + PWA
  manifest from one template. Instances: `wgi/guard`, `wgi/percussion`,
  `wgi/winds` (WGI activities are separate apps, chosen from the logo menu —
  no in-app activity filter), `boa`, `acappella`, `showchoir`.
- `docs/modes.js` (the logo menu) and `docs/modes.html` (the landing page)
  are the only cross-app chrome. All three builders run in `pages.yml` on
  every deploy.

## Why

The owner wants every app to feel exactly like the DCI dashboard — same
scoreboard, events, profiles, stats, settings, share cards — and wants DCI
itself frozen. Deriving the engine (rather than forking or rewriting) keeps
one source of truth while guaranteeing DCI is never modified by family work.

## Honesty rules carried forward

Family datasets are demo seasons and say so on every page. Event-scoped
activities (BOA, Show Choir, A Cappella) carry a strip noting that scores
compare within an event. Notification preferences exist per app but state
plainly that alerts activate only when a permitted live source exists.
