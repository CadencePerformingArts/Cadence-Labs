# Master-prompt audit — all 41 sections (0–40), 2026-08-08

Legend: ✅ meets the expectation · ⚠️ partial (works, gaps noted) · ❌ not built yet

| # | Section | Status | Evidence / gap |
|---|---------|--------|----------------|
| 0 | Study existing DCI first | ✅ | Engine is *derived* from the DCI app by asserted transforms (scripts/build_family_engine.py) — the study is enforced by the build |
| 1 | DCI design = source of truth | ✅ | Every app runs the same generated engine; a family screen literally cannot drift from DCI |
| 2 | Refactor before duplicating | ✅ | Zero duplicated views; generalization via APP_CFG config only |
| 3 | One platform, not hardcoded to N circuits | ✅ | Adding a circuit = one config entry + one dataset dir; 11 today |
| 4 | Circuit categories | ✅ | Switcher + landing grouped: Drum corps / WGI / Marching band / Regional indoor |
| 5 | Circuit data model | ✅ | Uniform contract (classes, seasons, events, results, champions, records, terms); ⚠️ circuit logos are text/emoji identity |
| 6 | Navigation | ✅ | Categorized switcher, WGI flyout, Explore page; ⚠️ favorites/calendar/search are per-app destinations, not global |
| 7 | Functional parity with DCI | ✅ | Scores/shows/rankings/profiles/history/compare everywhere data permits; captions on DCI+BOA+WGASC+TCGC+FFCC; predictions/Ask stay DCI-only by design |
| 8 | Universal score system | ✅ | One schema + resultsKind (score/rating/placement); per-circuit captions; ⚠️ advancement status not modeled as a field |
| 9 | Ensemble profiles generalized | ✅ | One profile view for corps/bands/guards/perc/winds + Ensemble Pro official content |
| 10 | One favorites system | ✅ | Favorites sync per account across devices; ⚠️ no single cross-app favorites *view* yet |
| 11 | Universal calendar | ❌ | Per-app Shows tabs only — top backlog item |
| 12 | Event pages | ⚠️ | Rich event rows (lineup, results, recaps, live) inside Shows; claims support kind='event'; no standalone event URL/page yet |
| 13 | Rankings | ✅ | Per-class standings, movers/battles, honest basis labels (ratings/placements labeled as such) |
| 14 | Score analytics | ✅ | Trends, multi-ensemble multi-season compare, caption analysis where captions exist |
| 15 | Historical data | ✅ | DCI→1972, BOA→1976, ISSMA→1973, UIL→1979, winter circuits→2013/2008; US Bands full backfill pending |
| 16 | Universal search | ❌ | Per-app search only — backlog |
| 17 | Personalized Cadence Home | ❌ | Landing is a picker; account favorites make this buildable — backlog |
| 18 | Onboarding | ⚠️ | Landing + sign-in exist; no guided pick-your-circuits flow |
| 19 | Notifications | ⚠️ | Full preference architecture for all 11 apps + real push on DCI; family push senders next |
| 20 | Cadence+ | ✅ | One cross-ecosystem subscription; configurable pricing; Stripe checkout + webhook fulfillment live in test mode; ⚠️ paid-feature gating not yet enforced (beta = everything free) |
| 21 | Ensemble Pro | ✅ | v1 shipped: in-app claims, admin dashboard, full official profile (staff/repertoire/auditions/positions/merch/donate/sponsors/announcements/videos/alumni), roles, $149 configurable |
| 22 | Recruitment/auditions | ⚠️ | Auditions + open positions publishable per ensemble; no cross-app "browse openings" surface |
| 23 | Event Pro | ⚠️ | Pricing page + claims architecture; no event-admin dashboard yet |
| 24 | Sponsorship | ⚠️ | Ensemble-level sponsors ship labeled "Sponsor"; no platform placements/components |
| 25 | Database/backend | ✅ | Supabase Postgres, FKs, indexes, RLS on every table, security advisors clean, migrations in repo, roles |
| 26 | Multi-circuit membership | ❌ | Ensembles are per-app identities; canonical cross-circuit entity is future work |
| 27 | Data ingestion architecture | ✅ | Provider-per-circuit scrapers → one schema; validation gates, caching, resumability, permission-first (WGI email); ⚠️ scheduled crons for the five new circuits pending |
| 28 | Admin area | ⚠️ | platform_admin role + documented SQL approval workflows; no admin UI |
| 29 | Design requirements | ✅ | One design system by construction |
| 30 | Mobile | ✅ | Mobile-first; every merge smoke-tested at phone viewport; installable PWA |
| 31 | Accessibility | ⚠️ | aria labels/expanded/pressed, focus states, text-size setting; no formal audit |
| 32 | Demo data clearly labeled | ✅ | Shipped data is real or explicitly labeled pending/gated; demo wording purged |
| 33 | Don't destroy DCI | ✅ | DCI changes additive only (account card, claim line); behavior preserved |
| 34 | Phased implementation | ✅ | Executed phases 1→7 in order |
| 35 | Real functionality over mockups | ✅ | Real data, real auth, real (test-mode) payments; coming-soon is labeled, never faked |
| 36 | Performance | ✅ | Chunked static JSON (decades/seasons), content-hash cache busting, lazy loads, batched analytics |
| 37 | One-ecosystem principle | ⚠️ | One account/sub/prefs/claims ✅; the per-app calendar/search/home gaps are what remains |
| 38 | Final design review | ✅ | Continuous — family screens are generated from DCI's |
| 39 | Test everything | ⚠️ | Playwright smoke suite per merge + pipeline validation gates; no unit-test suite |
| 40 | Final report | ✅ | This document |

## The honest gap list (what ❌/⚠️ add up to)
1. Universal calendar, universal search, personalized home, guided onboarding (the "one ecosystem" UX layer)
2. Push alert senders for the 10 non-DCI apps
3. Event Pro admin dashboard + standalone event pages
4. Cadence+ feature gating (deliberately off during beta)
5. Admin UI (SQL workflows suffice at current scale)
6. Multi-circuit canonical ensembles
7. US Bands full backfill; scheduled ingest crons for UIL/ISSMA/WGASC/TCGC/FFCC
8. Platform sponsorship components; formal a11y audit; unit tests
