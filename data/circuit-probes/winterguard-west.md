# Circuit probe: winterguard-west — WGASC (SoCal), TCGC (Texas), FFCC (Florida)

Probed 2026-08-07 by live fetches from this sandbox (curl + Wayback + CompetitionSuite
bridge tests via `PYTHONPATH=scraper python3 -c "import scrape_compsuite as cs; cs._bridge(...)"`).

## Headline

**All three circuits are CompetitionSuite orgs and all three are reachable through the
bridge from this sandbox — verified with live JSON responses.** The bridge returns
totals + ranks directly (no recap-page parsing needed for scores), and the recap .htm
pages use the exact `scoreTable` / `data-translate-number` markup the existing
`scraper/scrape_compsuite.py` parser already targets. Verdict for the group:
**LIVE-READY (effort S each)**.

Two structural findings that shape the adapter:

1. **No org GUIDs are publicly discoverable** for these circuits (unlike WGI, none of
   them embeds `organization=<guid>` anywhere; the numeric org id visible in recap
   logo paths, e.g. WGASC = 10903, gets HTTP 400 from `GetSeasons`). **But org GUIDs
   are not needed**: `GetCompetition/jsonp?competition=<any recap or schedule GUID>`
   returns a `seasonGuid`, and `GetCompetitionsBySeason/jsonp?season=<guid>` returns
   the org initials + the season's complete competition list. One Google-indexed
   recap/schedule link per season unlocks the whole season. Season GUIDs found so far
   are tabulated below — they can be committed as config.
2. **The bridge payload is richer here than the DCI flow assumes.** Verified live:
   `GetCompetition` → `rounds[].performances[] = {name, city, state, score, rank}`
   (e.g. WGASC 2025-02-22, HS AA Round 1: "Chaminade College Prep." 53.7 rank 1).
   A totals-level adapter is pure JSON — the same season→competitions→rounds walk
   `scrape_wgi.py` already implements, just entered at a season GUID instead of an
   org GUID. Caption-level backfill via the recap .htm pages needs one small regex
   tweak (see Blockers).

## Shared blocker: all three live sites captcha this sandbox

`wgasc.org`, `texascolorguardcircuit.org` (and `tcgc.net`), and `ffcc.org` are all
SiteGround-hosted and all answer this sandbox's curl with HTTP 202 + a
`/.well-known/sgcaptcha/` JS challenge (verified 2026-08-07; WebFetch renders empty
too). This blocks *link discovery on the circuits' own sites* from here — nothing else:

- `bridge.competitionsuite.com/api/orgscores/*` — fully open (all tests below).
- `recaps.competitionsuite.com/<guid>.htm` — open (200, full recap HTML).
- `schedules.competitionsuite.com/<guid>_*.htm` — open; the schedule GUID **is** the
  competition GUID (tested: WGASC 2026 champs schedule GUID resolves in `GetCompetition`).
- Wayback Machine has the circuits' scores pages (used below).
- Google-indexed recaps/schedules links provide per-season seed GUIDs.
- Production runner (GitHub Actions) IPs may not be captcha'd — untested from here.

Probe hygiene note: `cs._bridge()` retry-storms on hard 400s (default 4 retries × 2
URL forms + rate-limit sleeps ≈ 2 min per bad GUID). Use `retries=1` when testing
candidate GUIDs in bulk.

---

## 1. WGASC — Winter Guard Association of Southern California (~300+ guards; largest regional winter circuit)

### Official site + where scores live
- Site: https://wgasc.org (WordPress). Scores hub: https://wgasc.org/scores/ —
  a season grid of per-event pages `https://wgasc.org/events/<id>/`, each linking
  `recaps.competitionsuite.com/<competition-guid>.htm`.
  Evidence (Wayback, site itself is captcha'd from sandbox):
  `web.archive.org/web/20241010055327/https://wgasc.org/scores/` (event grid),
  `web.archive.org/web/2024/https://wgasc.org/events/21462/` (carries recap link
  `recaps.competitionsuite.com/2736759f-c252-425b-930c-f9f3ad99ae43.htm`).
- Site also links `competitionsuite.com/overview/organizations/10903/resources/`
  (WGASC's numeric CompetitionSuite org id; rejected by the bridge, which wants GUIDs).

### Data mechanism — CompetitionSuite, bridge-tested LIVE
- `GetCompetition?competition=79cf6abe-9401-4301-ab5a-1629f7658931` → 2025-02-22
  "Color Guard", **11 rounds**, each with `fullRecapUrl` + performances (name/score/rank).
- `GetCompetition?competition=54d5495d-97e6-459c-81d5-bb35c94765ee` → "WGASC CG
  Championship" 2025-04-12, 7 rounds.
- `GetCompetitionsBySeason?season=eb34e61d-ec78-4d35-b6e7-ca07df869786` →
  org **WGASC**, season "2025", **41 competitions**.
- Current season: schedule GUID from Google (`schedules.competitionsuite.com/
  f9a591d5-8e5c-48c7-8ca9-57555bf4bdab_logistical.htm`) resolves via `GetCompetition`
  → "WGASC Color Guard Championships" 2026-04-19 (Bren Events Center, UCI), 9 rounds,
  season `234b42a3-d573-4994-98a5-2b3bd383f9da` "2026" = **48 competitions**.
- Recap markup check: `recaps.competitionsuite.com/54d5495d-….htm` has 795
  `scoreTable` blocks + `data-translate-number` cells + "City, CA" anchor columns —
  same format the DCI recap parser consumes.

### Season GUIDs in hand
| Season | GUID | Comps |
|---|---|---|
| 2026 | `234b42a3-d573-4994-98a5-2b3bd383f9da` | 48 |
| 2025 | `eb34e61d-ec78-4d35-b6e7-ca07df869786` | 41 |
| 2021 | `0511f333-bd69-4540-891f-2b1572d97b06` | 0 scored (calendar items only — COVID year) |

### Historical depth
- Bridge era: at least 2021–2026 (2023/2024 season GUIDs harvestable the same way from
  Wayback copies of `/events/<id>/` pages — 2023 scores-page snapshots exist:
  CDX 20230324, 20230921, 20231203, 20240521, 20241010, 20241204).
- Pre-CompetitionSuite: `scores2004.aspx` … `scores_2011.aspx` + `scores_archives.aspx`
  in Wayback (inline-era pages, ~3 KB each) and `wgasc.org/archivepdfs/*.pdf` — a
  separate salvage job if deep history is ever wanted.

### Verdict: **LIVE-READY (S)** — biggest winter circuit in the country, bridge serves
totals+ranks as JSON today; adapter is the existing WGI walk entered at a season GUID.

---

## 2. TCGC — Texas Color Guard Circuit (~200+ units)

### Domain correction up front
- **`tcgc.org` is NOT the circuit** — it is "Tri-County Gun Club" (fetched live:
  firearms training facility). `tcgc.net` is also not it (SiteGround captcha page,
  unrelated). The real site is **https://texascolorguardcircuit.org**.
- `tcgc.compsuite.io/scores` (CompetitionSuite's hosted scores subdomain, still
  Google-indexed) is **dead**: Cloudflare 1016 "Origin DNS error" (fetched live).

### Official site + where scores live
- Scores archive: https://texascolorguardcircuit.org/scores ("Past Events & Scores") —
  **one page carrying 302 distinct `recaps.competitionsuite.com/<guid>.htm` links**
  (counted in Wayback snapshot `web.archive.org/web/20240301050724/
  https://texascolorguardcircuit.org/scores`). Current-season recaps live on
  per-event pages `texascolorguardcircuit.org/events/<slug>` and
  https://texascolorguardcircuit.org/scores-and-recap (Google-indexed; not in Wayback;
  site captcha'd from sandbox).

### Data mechanism — CompetitionSuite, bridge-tested LIVE
Sampled 12 of the 302 GUIDs through `GetCompetition` → `GetCompetitionsBySeason`;
every one resolved. Distinct seasons hit by the sample (org initials **TCGC** on all):

| Season | GUID | Comps |
|---|---|---|
| 2024 Winter Season | `6d4ae385-fa53-4476-b0c8-88a3cf9a69e5` | 45 |
| 2023 Winter Season | `c34e8f2c-9745-430b-a1d6-303e088b4832` | 42 |
| 2022 Winter Season | `637b2455-7a45-4191-afde-ab59e658b971` | 35 |
| 2020 Winter Season | `beae23b7-9e65-4e9e-93ad-244d37190957` | 27 |
| 2019 Winter Season | `f1628b29-f585-4e16-8e1c-345d0e720144` | 28 |
| 2015 Winter Season | `2716ec64-fa93-4ccc-891e-863b76ec7460` | 24 |
| 2014 Winter Season | `25bca0d4-cbc7-474a-a699-d7a2b62c304a` | 26 |

(2016–2018 + 2021 GUIDs are in the un-sampled remainder of the 302-link page —
the full list is cached at the Wayback URL above.)
- Example: `GetCompetition?competition=01053e2e-5d00-4b28-ba5e-c96acfa6b9bb` →
  "March 5 - Katy HS (CG)" 2022-03-05, 10 rounds. Its recap .htm: **1254 scoreTable
  blocks** — parser-compatible.
- 2025/2026 season GUIDs: not yet in hand (current pages not Wayback-archived, site
  captcha'd from sandbox) — one Google-indexed schedules/recaps link, or one fetch of
  `/scores-and-recap` from an un-captcha'd runner, seeds each.

### Historical depth
**A full decade (2014–2024) already resolvable through the bridge today** from the
cached 302-GUID page — the deepest archive of the three circuits. Pre-2014:
`scores&event_show_id=N` inline pages in Wayback (2015–2016 era).

### Verdict: **LIVE-READY (S)** — ~200-unit audience with 10 seasons of bridge data
reachable right now; only the current-season seed GUID needs an out-of-sandbox fetch.

---

## 3. FFCC — Florida Federation of Colorguards Circuit (~220+ member teams: CG, percussion, winds)

### Official site + where scores live
- Site: https://ffcc.org (WordPress). Scores hub:
  `https://ffcc.org/events/scores-ffcc/?eventID=<n>` — per-event pages listing
  per-round recap links. Evidence (Wayback): `web.archive.org/web/20240808005227/
  https://ffcc.org/events/scores-ffcc/?eventID=33` carries 25 distinct
  `recaps.competitionsuite.com/<guid>.htm` links; 2025 event pages
  (`ffcc.org/event/<slug>`, e.g. ffcc-freedom-hs-orlando-p-w-cg, snapshot 20250221)
  link recap + `_standard.htm` / `_logistical.htm` schedule variants.

### Data mechanism — CompetitionSuite, bridge-tested LIVE
| Season | GUID | Comps | Seed competition tested |
|---|---|---|---|
| 2026 FFCC Indoor | `bfc650fc-d8a1-4104-82e3-536e41a96a6f` | 27 | `4f24fb84-…e337b8` Champs National Classes 2026-04-03, 11 rounds (GUID from Google-indexed schedules link) |
| 2025 FFCC Indoor | `b4ab4a18-9032-4d96-81ea-0be91abc5ae9` | 30 | `027eb4f6-…3b7b` Freedom HS Orlando (CG) 2025-02-22, 7 rounds |
| 2024 FFCC Indoor | `f263a5ec-7f64-4a69-b3ad-5f58913bc697` | 25 | `e433d116-…5e61bc` Plant City HS 2024-02-17, 11 rounds |

- Org initials **FFCC** confirmed on every season response.
- Recap markup: `recaps.competitionsuite.com/027eb4f6-….htm` → **817 scoreTable
  blocks**, parser-compatible. Gotcha: the `_standard.htm` variant of the same GUID
  returns **403 "Not Available - CompetitionSuite"** — always fetch the plain `.htm`.

### Historical depth
- Bridge era: 2024–2026 confirmed; earlier seasons discoverable the same way from
  Wayback `scores-ffcc` snapshots (hub archived since ~2024) and older event pages.
- Pre-CompetitionSuite (≥2015–2019): `ffcc.org/colorguard-scores/?eventID=N` pages in
  Wayback contain **clean inline HTML score tables**
  (`<td class="ensembleName …">Liberty Middle School</td><td class="totalScore …">51.27</td>`
  + academicRating) — trivial historical backfill if wanted.

### Verdict: **LIVE-READY (S)** — three seasons on the bridge already seeded, includes
percussion + winds (widens the app beyond guard), inline-HTML history as a bonus.

---

## Adapter notes (applies to all three)

1. Reuse the `scrape_wgi.py` walk but enter at **season GUIDs from config** (skip
   `GetSeasons/organization=` — no public org GUIDs). Totals + ranks come straight
   from `GetCompetition` JSON; no HTML parsing needed for the score layer.
2. Caption-level recaps: `scrape_compsuite.py`'s `_ANCHOR` regex expects the unit-name
   `<td>` bare (`<td class='content topBorder rightBorderDouble'>NAME`); in these
   circuits' recaps both name and location cells carry
   `style='padding-left: 5px;padding-right: 5px;'` — widen the regex with `[^>]*`
   on the first cell. Everything else (scoreTable, data-translate-number, rank cells,
   "City, ST" location column) matches the existing parser.
3. New-season seeding is the only recurring manual/off-sandbox step: one recap or
   schedule GUID per circuit per season (Google-indexed within days of the first show;
   schedule GUIDs double as competition GUIDs).
