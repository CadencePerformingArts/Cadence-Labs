# Data Sources

Where each mode's data can come from, what we use today, and the rules for
getting it.

## The sourcing priority ladder

For every mode, prefer sources in this order — take the highest rung available:

1. **Official API** (documented, keyed access).
2. **Official feed** (JSON/CSV/RSS the organization publishes).
3. **Permitted public pages** (scraping allowed by terms/robots, rate-limited).
4. **Licensed data** (paid or written permission).
5. **Verified admin import** (a trusted human enters results from official
   postings).
6. **Labeled fixtures** (demo data, clearly badged, never presented as real).

Hard rule, no exceptions: **never bypass authentication, bot protection,
paywalls, or rate limits, and never scrape a source whose terms forbid it.**
When in doubt, drop down the ladder. Cadence is an unofficial fan project and
behaves like a polite guest.

## Per-mode status

### DCI — adapter status: **snapshot via legacy scraper — working**
- **Sources:** DCI.org scores (powered by Competition Suite) for 2013+ with
  caption recaps; drum-corps.net archives (2001+); The Sound Machine historical
  finals (1972–2004); Wikipedia for DCA champions; news feeds.
- **Format:** HTML pages, parsed by `scraper/*.py` into `docs/data/*.json`.
- **Reliability:** high in-season; the pipeline has run for multiple seasons.
  Scrapers are rate-limited and cache aggressively (`data/raw/`).
- **Terms:** public pages; unofficial fan project, prominently credited.
  Attribution kept in README and in-app data-source notes.
- **App path:** `scripts/gen_dci_snapshot.py` turns `docs/data/` into the
  in-app snapshot (provenance kind `snapshot`), regenerated on each web deploy
  so it tracks the twice-daily scrape.

### WGI (Color Guard, Percussion, Winds) — adapter status: **fixture, research needed**
- **Candidates:** wgi.org scores pages / CompetitionSuite postings.
- **Terms:** review required before any live adapter; WGI has not published a
  feed for this build. Until cleared: labeled fixtures only.

### Bands of America — adapter status: **fixture, research needed**
- **Candidates:** marching.musicforall.org results postings (PDF/HTML).
- **Terms:** Music for All terms review required first. Event-scoped data model
  (no season table) is already correct in the domain layer.

### Competitive A Cappella (ICCA/ICHSA/The Open) — adapter status: **fixture, research needed**
- **Candidates:** varsityvocals.com results pages; The Open's postings.
- **Terms:** Varsity Vocals terms review required. Tournament data (points
  within a round, advancement by region) is small — a verified admin import may
  beat scraping entirely.

### Show Choir — adapter status: **fixture; admin import is the plan**
- **Reality:** no national source exists. Hundreds of independent invitationals
  post results on host-school pages and social media, inconsistently.
- **Plan:** rung 5 — verified admin import per event, with community
  submissions verified against official postings. Aggregators may inform, but
  are not authoritative or license-cleared.

## Fixtures are labeled, always

WGI, BOA, A Cappella, and Show Choir currently run on fixtures: real ensemble
names, invented scores, provenance kind `fixture`, DEMO DATA badge in the UI.
Tests enforce the labeling. Shipping a mode "for real" means completing a terms
review, building an adapter in `packages/ingestion` with contract tests, and
flipping `dataStatus` — never just removing the badge.

## Attribution

Every source gets credit: in the repo README, in each mode's
`dataSourceNote`, and on any screen where its data is primary. The `sources`
table (target schema) stores the attribution text and terms-review status so it
travels with the data.
