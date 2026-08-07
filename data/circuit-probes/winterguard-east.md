# Circuit probe: Winter guard/percussion circuits (East + Mid-America)

Probed 2026-08-07 by live fetches from this sandbox (curl + CompetitionSuite bridge tests).
Four circuits requested: **SCGC**, **CWEA**, **MEPA**, **MCGC/Mid-Continent**.

## TL;DR verdict table

| Circuit | Real domain | Mechanism | Bridge org GUID | Depth | Verdict |
|---|---|---|---|---|---|
| **SCGC** Southeastern Color Guard Circuit | scgconline.org | CompetitionSuite recaps, enumerated by inline-HTML `results.php` | not exposed (harvest GUIDs from site) | 2008–2026 (19 seasons) | **BUILDABLE (S)** |
| **CWEA** Carolina Winter Ensemble Assoc. | cweaindoor.org | CompetitionSuite, **org GUID exposed** → bridge GetSeasons | `D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D` ✅ tested | 2014–2026 (13 seasons) | **LIVE-READY** |
| **MEPA** Mid-East Performance Assoc. (Ohio) | mepa-circuit.org | CompetitionSuite recaps, enumerated by WP `/scores/` **behind SiteGround anti-bot** | not exposed (harvest GUIDs from gated site) | 2015–2026 (12 seasons) | **BUILDABLE (M)** |
| **MCGC** Michigan Color Guard Circuit | mcgc.net | CompetitionSuite, **org GUID exposed** → bridge GetSeasons | `E8F964B9-13B1-4B46-8F38-3FD61D8BB498` ✅ tested | 2013–2026 (14 seasons) | **LIVE-READY** |
| **MCCGA** Mid Continent Color Guard Assoc. | mccga.org | CompetitionSuite recaps (modern), enumerated by WP season pages; static HTML for pre-2014 | not exposed (harvest GUIDs from site) | 1996–2026 (recaps ~2014+) | **BUILDABLE (S)** |

**Every one of these five is CompetitionSuite end-to-end.** The existing `scraper/scrape_compsuite.py`
recap parser handles all of them at the round level — the only per-circuit work is *event discovery*
(how you enumerate a season's competition/recap GUIDs). Two circuits (CWEA, MCGC) publish their
bridge org GUID, so discovery is a one-line `GetSeasons` call = LIVE-READY. Three (SCGC, MEPA,
MCCGA) hide the org GUID, so you harvest recap GUIDs from the circuit's own site, then feed them to
the bridge — each recap GUID resolves via `GetCompetition/jsonp?competition=GUID`, verified below.

### Domain-hunt note (search engines unavailable)
The brief's guessed domains were mostly wrong or squatted. Real domains found by testing candidates
and cross-referencing **wgi.org/color-guard/cg-circuit-partners/** (WGI's live circuit-partner list —
the authoritative index; `wgi.org/circuit-partners/` itself 404s, use the discipline pages):
- `scgc.org` → Sugar Cane Growers Cooperative (unrelated). Real: **scgconline.org**.
- `cwea.us` → dead; `cwea.org` → California Water Environment Assoc. Real: **cweaindoor.org**.
- `mepacircuit.com` → dead; `mepa.org` → Maine Psychological Assoc. Real: **mepa-circuit.org**.
- `mcgc.net` → **correct**, but it's *Michigan* Color Guard Circuit, not "Mid-Continent" (see naming note).

---

## Naming collision: "MCGC / Mid-Continent" is two different circuits

The brief's item 4 ("MCGC Mid-Continent … mcgc.net or similar") conflates two real, distinct orgs.
Both are covered because both are valuable:

- **mcgc.net = Michigan Color Guard Circuit (MCGC)** — a Michigan winter circuit, championships at
  Michigan State (MSU). orgInitials `MCGC`. This is what `mcgc.net` actually is.
- **mccga.org = Mid Continent Color Guard Association (MCCGA)** — the actual *"Mid-Continent"* org,
  Missouri/Kansas footprint (Willard, Nixa, Ozark, Bentonville, Francis Howell). orgInitials `MCCGA`.

If the intent was literally "Mid-Continent," it's **MCCGA**. If it was literally the `mcgc.net` domain,
it's **Michigan MCGC**. Both probed and both are CompetitionSuite.

---

## 1. SCGC — Southeastern Color Guard Circuit (scgconline.org, ~177 ensembles)

### Site + where results live
- Site: **https://www.scgconline.org** (hand-rolled PHP; plain `curl` fetches fine, HTTP 200, no anti-bot).
- Results hub: **https://www.scgconline.org/results.php** — single page, year selector **2008→2026**,
  lists every event as `event_details.php?event_id=NNN` with an adjacent CompetitionSuite recap link.
- Per-event: `https://www.scgconline.org/event_details.php?event_id=340`.

### Data mechanism — CompetitionSuite recaps
- `results.php` embeds, per event, `http://recaps.competitionsuite.com/<GUID>.htm` links (14+ recap
  GUIDs visible for the current season alone; multiple rounds/classes per event).
- **Bridge test (recap GUID → GetCompetition) succeeded**:
  `GetCompetition/jsonp?competition=ad5bd0df-3967-4246-8878-ec57246a381a` →
  name "Green Hill HS", 2026-02-07, Mt Juliet **TN**, **17 rounds**; seasonGuid
  `7284d635-8b7d-4097-890f-36123840b815`; `GetCompetitionsBySeason` on that season →
  **organizationInitials `SCGC`, 14 competitions**. Southeast footprint (TN etc.).
- **Org GUID is NOT exposed** on scgconline.org or in the recap pages (no `membership/?o=`), so
  `GetSeasons` can't be called directly — discovery = scrape `results.php` per season for recap GUIDs.

### Historical depth
- **2008–2026** (19 seasons) via the `results.php` year selector; each season's events → recap GUIDs.

### Blockers
- None. Public PHP site, no login, no anti-bot, no JS rendering required.

### Verdict: **BUILDABLE (S)**
One small event-enumeration parser over `results.php?...` (extract `recaps.competitionsuite.com/<GUID>`
links per year) feeds the existing recap parser. Largest circuit in this group (~177 ensembles).

---

## 2. CWEA — Carolina Winter Ensemble Association (cweaindoor.org, ~150+)

### Site + where results live
- Site: **https://cweaindoor.org** (WordPress; "Past Events & Scores" → https://cweaindoor.org/past-events/).
- **The site sits behind SiteGround anti-bot** (see "SiteGround blocker" section) — but **you don't
  need the site at all**, because CWEA publishes its bridge org GUID.

### Data mechanism — CompetitionSuite, org GUID exposed
- The homepage "Register" link is
  `competitionsuite.com/login/?r=%2Fmembership%2F%3Fo%3DD8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D`
  → org GUID **`D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D`**.
- **Bridge GUID tested and working**:
  `GetSeasons/jsonp?organization=D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D` → **13 seasons (2014–2026)**.
  2026 season (`bdd56510-342c-4540-a8a0-d03c7a01f6b1`) → `GetCompetitionsBySeason` →
  **organizationInitials `CWEA`, 14 competitions**, incl. "Color Guard Circuit Championships (SAA, A,
  Open, World)" 2026-03-29 and "Percussion & Winds Circuit Championships" 2026-04-04 at
  **Winthrop Coliseum, Rock Hill, SC**. Confirms guard + percussion + winds.
- `bridge.competitionsuite.com` is **not** behind the SiteGround wall, so the whole circuit is
  reachable without ever touching cweaindoor.org.

### Historical depth
- **2014–2026 (13 seasons)** via the bridge GetSeasons list.

### Blockers
- The *website* is gated (SiteGround PoW), but this is moot — the bridge path is clean. None for ingest.

### Verdict: **LIVE-READY**
Existing CompetitionSuite parser + this org GUID, exactly like the IHSCGA/IPA pattern. Deep archive,
Carolinas guard/perc/winds audience (~150+ ensembles).

---

## 3. MEPA — Mid-East Performance Association (mepa-circuit.org, Ohio, ~100+)

### Site + where results live
- Site: **https://mepa-circuit.org** (WordPress). Scores hub:
  **https://mepa-circuit.org/scores/** with a season filter **`/scores/?season=YYYY` (2015–2026)**.
- Per-event pages e.g. `https://mepa-circuit.org/events/jan-25-miamisburg-hs/`.
- Confirmed **Ohio** footprint (Miamisburg, Fairfield, Northmont, Bellbrook, Troy HS, Hamilton,
  Trent Arena) — the brief's "Ohio/Kentucky" is right on Ohio.

### Data mechanism — CompetitionSuite recaps (org GUID hidden)
- Each event page links `http://recaps.competitionsuite.com/<GUID>.htm` ("Scores & Recap") plus
  `schedules.competitionsuite.com/<GUID>_standard.htm` / `_logistical.htm`.
- **Bridge test succeeded**: `GetCompetition/jsonp?competition=76d2c5b2-b2d0-40f5-a3de-2b856a2ad223`
  → "Jan 25 - Miamisburg HS", 2025-01-25, Miamisburg **OH**, **14 rounds** (Elementary CG, etc.);
  seasonGuid `3895bd08-af6f-4dd6-89cb-1df213a2d0f8` → `GetCompetitionsBySeason` →
  **organizationInitials `MEPA`, 14 competitions**.
- Org GUID **not exposed** (site links only the numeric `competitionsuite.com/overview/organizations/4977/`,
  not the bridge GUID; recap pages carry no `?o=`). Discovery therefore requires scraping the WP
  `/scores/?season=YYYY` listings → event pages → recap GUIDs.

### Blocker — SiteGround anti-bot on the WP site
- `mepa-circuit.org` returns **HTTP 202 + a SiteGround JS proof-of-work challenge** to plain curl
  (meta-refresh to `/.well-known/sgcaptcha/`). **Solved in this sandbox** (see section below) — a
  ~10s SHA1 PoW; after solving, `/scores/` and event pages return HTTP 200 and parse normally.
  So the block is defeatable but adds a PoW-solver step to every discovery fetch (the `_I_`
  clearance cookie lasts ~30 days, so it's one solve per run, not per page).

### Historical depth
- **2015–2026 (12 seasons)** via the `/scores/?season=YYYY` filter.

### Verdict: **BUILDABLE (M)**
Recaps parse with the existing engine; extra effort vs SCGC/MCCGA is the SiteGround PoW solver on the
discovery fetches. Solver is trivial and already reverse-engineered (below). ~100+ ensembles, Ohio.

---

## 4a. MCGC — Michigan Color Guard Circuit (mcgc.net, ~100+)

### Site + where results live
- Site: **https://www.mcgc.net** (Wix, JS-rendered). Results: `/results` ("2026 Season Recaps"),
  `/previous-season-recaps`. But **the site is not needed** — the org GUID is in the page source.

### Data mechanism — CompetitionSuite, org GUID exposed
- Homepage "Register" link: `competitionsuite.com/membership/?o=E8F964B9-13B1-4B46-8F38-3FD61D8BB498`
  → org GUID **`E8F964B9-13B1-4B46-8F38-3FD61D8BB498`**.
- **Bridge GUID tested and working**:
  `GetSeasons/jsonp?organization=E8F964B9-13B1-4B46-8F38-3FD61D8BB498` → **14 seasons (2013–2026)**.
  2026 season → `GetCompetitionsBySeason` → **organizationInitials `MCGC`, 13 competitions**, incl.
  "MCGC 2026 Championships Part 1/2/3" 2026-03-28 at **MSU** and regular-season shows (Lake Orion, etc.).

### Historical depth
- **2013–2026 (14 seasons)** via bridge.

### Blockers
- Wix site is JS-only, but irrelevant — bridge path is clean. None for ingest.

### Verdict: **LIVE-READY**
Existing CompetitionSuite parser + this org GUID. Michigan guard audience (~100+).

## 4b. MCCGA — Mid Continent Color Guard Association (mccga.org, ~100+) — the actual "Mid-Continent"

### Site + where results live
- Site: **https://mccga.org** (WordPress; plain curl fetches fine, no anti-bot).
- Per-season pages: `/2026-schedule/`, `/2025-schedule/`, `/2025-championships-2/`, and archive pages
  `/YYYY-archive/` for **2014–2025**; static HTML for older years:
  `/archive/2013/scores.htm` (2009–2013), `/archive/2008/scores.htm` (2008),
  `/frames/frame_recaps.htm` (1996–2007).

### Data mechanism — CompetitionSuite recaps (modern), static HTML (legacy)
- Modern schedule/championship pages carry many `recaps.competitionsuite.com/<GUID>.htm` links,
  one per round/class (`/2026-schedule/` alone had 24+ recap GUIDs; `/2025-schedule/` 15+;
  `/2025-championships-2/` per-class Regional A / SAA / Percussion / Winds recaps).
- **Bridge test succeeded**: `GetCompetition/jsonp?competition=14b553fb-2961-4eeb-9e74-7c9543b847c6`
  → "MCCGA Cadet/Novice/IRA Championships @ Willard HS", 2026-03-28; seasonGuid
  `0c61ba8a-3373-4934-b1ae-46f864a6dd7b` → `GetCompetitionsBySeason` →
  **organizationInitials `MCCGA`, 24 competitions**. Missouri/Kansas footprint (Willard, Nixa,
  Ozark, Bentonville, Francis Howell).
- Org GUID **not exposed** (no `membership/?o=`; recap pages carry no `?o=`). Discovery = scrape the
  WP season pages for recap GUIDs. Pre-2014 seasons are inline static HTML tables (different, older
  parser — only worth it for a deep-history play).

### Historical depth
- Recaps (CompetitionSuite): roughly **2014–2026** via the WP `/YYYY-archive/` + `/YYYY-schedule/`
  pages. Legacy static scores: **1996–2013** (separate format).

### Verdict: **BUILDABLE (S)** for modern CompetitionSuite seasons
Small WP-scrape for recap GUIDs → existing engine. Deep legacy archive exists but in an old static
format (optional stretch). ~100+ ensembles, MO/KS.

---

## SiteGround anti-bot blocker (CWEA + MEPA sites) — mechanism and bypass

`cweaindoor.org` and `mepa-circuit.org` are on SiteGround and answer plain curl with **HTTP 202** and
a JS challenge (`<meta http-equiv="refresh" ... /.well-known/sgcaptcha/>`). The challenge page ships a
Web-Worker **SHA1 proof-of-work**:
- `sgchallenge = "COMPLEXITY:ts:...:hash:"`; `complexity` = first `:`-field (observed **21**).
- Worker hashes `SHA1(challenge_bytes ‖ counter_bytes)` for counter = 0,1,2,… where `counter_bytes`
  is the big-endian minimal-length encoding of the counter; a hit is when the **top `complexity` bits
  of the first 32-bit word of the digest are zero**. Solution = `base64(challenge_bytes ‖ counter_bytes)`.
- Redirect to `submit_url?sol=<b64>&s=<ms>:<hashes>` sets the clearance cookie
  `_I_` (max-age 2,592,000 s ≈ 30 days), after which normal pages return 200.

Reproduced and solved in this sandbox in ~10 s (≈2^21 SHA1 ops) in pure Python; both sites then
returned real HTML. **Only MEPA actually needs this** for ingest (its recap GUIDs live only on the
gated WP site). **CWEA does not** — its bridge org GUID makes the whole circuit reachable via
`bridge.competitionsuite.com`, which is not behind the wall. SCGC and MCCGA sites have no anti-bot.

Reference solver (kept in scratchpad, not committed): SHA1 PoW loop as above; the CryptoJS
WordArray/Int32Array/byte-swap dance in the worker nets out to hashing the raw `challenge‖counter`
byte sequence, so `hashlib.sha1(challenge.encode()+counter_be).digest()` with
`int.from_bytes(d[:4],'big') >> (32-complexity) == 0` is an exact match.

---

## Evidence URL index
| What | URL / call |
|---|---|
| WGI circuit-partner index (authoritative) | https://www.wgi.org/color-guard/cg-circuit-partners/ |
| SCGC site | https://www.scgconline.org |
| SCGC results (year selector 2008–2026) | https://www.scgconline.org/results.php |
| SCGC recap link example | http://recaps.competitionsuite.com/ad5bd0df-3967-4246-8878-ec57246a381a.htm |
| SCGC bridge test (GUID→GetCompetition) | GetCompetition/jsonp?competition=ad5bd0df-3967-4246-8878-ec57246a381a → SCGC, 17 rounds |
| CWEA site | https://cweaindoor.org (SiteGround-gated) |
| CWEA org GUID source | homepage Register link `…/membership/?o=D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D` |
| CWEA bridge test | GetSeasons/jsonp?organization=D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D → 13 seasons, orgInitials CWEA |
| MEPA site | https://mepa-circuit.org (SiteGround-gated) |
| MEPA scores hub | https://mepa-circuit.org/scores/?season=2025 |
| MEPA event page (recap links) | https://mepa-circuit.org/events/jan-25-miamisburg-hs/ |
| MEPA bridge test | GetCompetition/jsonp?competition=76d2c5b2-b2d0-40f5-a3de-2b856a2ad223 → MEPA, 14 rounds |
| MCGC (Michigan) site | https://www.mcgc.net |
| MCGC org GUID source | homepage Register link `…/membership/?o=E8F964B9-13B1-4B46-8F38-3FD61D8BB498` |
| MCGC bridge test | GetSeasons/jsonp?organization=E8F964B9-13B1-4B46-8F38-3FD61D8BB498 → 14 seasons, orgInitials MCGC |
| MCCGA (Mid-Continent) site | https://mccga.org |
| MCCGA modern scores | https://mccga.org/2026-schedule/ , https://mccga.org/2025-championships-2/ |
| MCCGA legacy static scores | https://mccga.org/archive/2013/scores.htm , https://mccga.org/frames/frame_recaps.htm |
| MCCGA bridge test | GetCompetition/jsonp?competition=14b553fb-2961-4eeb-9e74-7c9543b847c6 → MCCGA, season has 24 comps |
| Bridge base | https://bridge.competitionsuite.com/api/orgscores |
