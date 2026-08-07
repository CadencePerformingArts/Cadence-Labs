# Circuit probe: ISSMA (Indiana) — fall marching band + Indiana winter circuits

Probed 2026-08-07 by live fetches from this sandbox (curl + CompetitionSuite bridge tests).

## Premise correction up front

The task brief said "ISSMA runs the winter circuits too." **It does not.** ISSMA's event
families are Marching Band, Solo & Ensemble, Jazz/Show Choir, and Concert Organization —
its site navigation and calendar contain zero winter guard / winter percussion content
(grep for `winter|guard|percussion` across issma.net home, mbinfo.php, calendar.php: 0 hits).
Indiana winter is run by two separate orgs, both probed below because that was the intent
of the ask:

- **IHSCGA** — Indiana High School Color Guard Association (winter guard): ihscga.org
- **IPA** — Indiana Percussion Association (winter percussion + winds): indianapercussion.org

Both are on CompetitionSuite with working bridge GUIDs (tested). ISSMA itself is not.

---

## 1. ISSMA fall marching band (~150–200 bands; Festival, Scholastic Prelims/Finals, Open Invitational → Regional → Semi-State → State at Lucas Oil)

### Official site + where results live
- Site: https://www.issma.net (hand-rolled PHP, HTML5UP template, no JS rendering needed)
- Results hub: https://www.issma.net/news.php ("News/Results" → "Event Results" section)
- Marching band info: https://www.issma.net/mbinfo.php (#results anchor)

### Data mechanism
- **No CompetitionSuite.** No `recaps.competitionsuite.com` links or bridge GUIDs anywhere
  on issma.net; web search confirms no ISSMA org on the recaps site. ISSMA tabulates
  in-house and serves scores only through its "Directors Only" portal.
- **Scores are login-gated.** Every scored-results link on news.php/mbinfo.php goes to
  `secure/scoreswarning.php?target=...` (targets: mbfestival, mbscholasticprelims,
  mbscholasticfinals, mbopeninv, mbregional, mbsemistate, mbstate), which 302s to
  `secure/login.php` (email+password directors login). Verified live 2026-08-07, and
  Wayback CDX shows `secure/scoreswarning.php` returning 401 as far back as **2005** —
  this has never been public. Mid-season snapshot (news.php, Nov 2025 via Wayback
  `web.archive.org/web/20251103id_/https://www.issma.net/news.php`) confirms Regional /
  Semi-State results links are gated even during the season.
- **Public = placements only, no scores**, inline HTML (trivially parseable):
  - https://www.issma.net/statembresults.php — Open Class State Finals placements
    (current year; 2025 edition live now: Class A–D, ranks 1–10, "Directors can view
    scores in the Directors Only Area" banner).
  - https://www.issma.net/statescholasticmbresults.php — Scholastic Class Finals
    placements (Scholastic A/B, ranks 1–5/6).
  - https://www.issma.net/concertfinalsresults.php, statejazzresults.php,
    statescresults.php — same pattern for non-MB divisions.
- ISSMA TV (https://tv.issma.net) is "SBN Network," a JS-only Vue streaming app —
  video, not data.

### Historical depth
- **https://www.issma.net/mbhistory.php — the gem: every State Finals placement
  1973–2025 on one public HTML page** (decade anchors 1970s–2020s; ~200 class blocks
  of rank+school; recent years link flipbook programs). Placements only, no scores.
- Current-season pages hold one year each; Wayback has statembresults.php snapshots
  per season back to 2022 (CDX: 20221113, 20231031, 20241111, 20251210 …) if we ever
  want year-page cross-checks, but mbhistory.php already covers all years.

### Blockers
- Directors-only login wall on ALL scored results, at every round, historic and current.
  Terms: scoreswarning interstitial implies redistribution sensitivity.
- No per-event public results (Invitational/Regional/Semi-State advancement lists are
  not published on issma.net; media outlets cover advancers).

### Verdict: **BUILDABLE (S) — placements-only; scores NOT-WORTH-IT (hard-gated)**
One trivial parser over mbhistory.php + the two current-season finals pages yields 50+
years of state-finals placements for a big audience (~200 bands, ~40k students, Lucas
Oil finals — the largest single-state MB audience after Texas). Scored recaps are
unobtainable without a directors login; do not build a scores adapter.

---

## 2. IHSCGA — Indiana winter guard (actual winter guard circuit)

- Site: https://www.ihscga.org (Wix). Homepage links
  `competitionsuite.com/membership/?o=219C70AB-66F9-462B-AB0A-86A4B4F62CB5` —
  exposing the org GUID.
- **Bridge GUID tested and working**:
  `GetSeasons/jsonp?organization=219C70AB-66F9-462B-AB0A-86A4B4F62CB5` →
  16 seasons: 2026 back through "2013 Winter Season" + "First Season".
  2026 season (166ffff4-e955-4476-99b7-1846184f9095) lists real competitions
  ("IHSCGA Finals - A, Open & World - Center Grove HS", 2026-03-21, Greenwood IN, etc.).
- Mechanism: CompetitionSuite end-to-end; existing `scraper/scrape_compsuite.py`
  pipeline applies as-is (seasons → competitions → per-round recap pages).
- Historical depth: **2013–2026 (14 named seasons)** via bridge.
- Blockers: none found.
- **Verdict: LIVE-READY** — existing CompetitionSuite parser + this org GUID; deep
  archive; natural companion to the WGI app for Indiana-heavy guard audience.

## 3. IPA — Indiana winter percussion + winds (actual winter percussion circuit)

- Site: https://indianapercussion.org (Squarespace). Scores page
  https://indianapercussion.org/scores embeds the CompetitionSuite orgscores widget:
  `<div data-compsuite-org='c196feef-4f95-4d62-a146-95b892a58f0a'>` +
  `bridge.competitionsuite.com/orgscores/orgscores.js`.
  (Careful: the many other GUIDs on IPA pages are Squarespace font-asset UUIDs — noise.)
- **Bridge GUID tested and working**:
  seasons 2017–2026 (10). 2026 season (ac9d5a57-3610-4220-a27c-ef210f3d9b11) → 15
  competitions incl. "IPA Percussion State Finals" 2026-03-28 at Indiana State
  University, with per-round `fullRecapUrl` on recaps.competitionsuite.com
  (e.g. http://recaps.competitionsuite.com/2bdb48c2-a296-443d-9b19-b6de61484e3d.htm).
  Divisions include percussion (PSA/PIA/PSO/PIO/PSW…) and a winds wing.
- Historical depth: **2017–2026 (10 seasons)** via bridge.
- Blockers: none found.
- **Verdict: LIVE-READY** — existing CompetitionSuite parser + this org GUID.

### Bridge implementation note
`GetCompetitionsBySeason` resolves by **season GUID alone** — passing IPA's org GUID
with an IHSCGA season GUID returned IHSCGA data (`organizationInitials: "IHSCGA"`).
Keep org→season pairs from the same `GetSeasons` call; don't mix.

---

## Evidence URL index
| What | URL |
|---|---|
| ISSMA results hub | https://www.issma.net/news.php |
| ISSMA MB info (#results) | https://www.issma.net/mbinfo.php |
| Gated score gateway (→login) | https://www.issma.net/secure/scoreswarning.php?target=mbstate |
| Public State Finals placements | https://www.issma.net/statembresults.php |
| Public Scholastic Finals placements | https://www.issma.net/statescholasticmbresults.php |
| Placement history 1973–2025 | https://www.issma.net/mbhistory.php |
| ISSMA TV (video only, JS app) | https://tv.issma.net |
| IHSCGA site | https://www.ihscga.org |
| IHSCGA bridge test | bridge.competitionsuite.com/api/orgscores/GetSeasons/jsonp?organization=219C70AB-66F9-462B-AB0A-86A4B4F62CB5 |
| IPA scores page (widget embed) | https://indianapercussion.org/scores |
| IPA bridge test | bridge.competitionsuite.com/api/orgscores/GetSeasons/jsonp?organization=c196feef-4f95-4d62-a146-95b892a58f0a |
| Wayback proof scores gated since 2005 | web.archive.org/cdx/search/cdx?url=issma.net/secure/scoreswarning.php* |
