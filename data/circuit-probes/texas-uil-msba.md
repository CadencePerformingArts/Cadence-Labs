# Circuit Probe: Texas UIL Marching Band + MSBA (Mid-States Band Association)

Probed 2026-08-07 by actually fetching every URL below from this sandbox (curl -sL and
`scraper/common.py fetch()`; CompetitionSuite bridge tested with `scrape_compsuite._bridge`).

---

## 1. UIL Texas Marching Band (~1000+ bands/season)

### Official sites and where results live

| Layer | URL | What's there |
|---|---|---|
| Program hub | https://www.uiltexas.org/music/marching-band (+ /region, /area, /state) | Rules, dates, links out to results systems. Fetched 200, static HTML. |
| **Region contests (the ~1000-band layer)** | https://www.texasmusicforms.com/marchrptuilpublic.asp | Official statewide UIL Marching Contest Report (vendor: CutTime LLC). Public, no login. Every region contest entry in the state: school, city, region #, directors, Varsity/Non-varsity, conference (A–6A), contest name+date, per-judge ratings (Score 1–3), final rating, judge names. |
| **State contest (SMBC)** | https://smbc.uiltexas.org/ | Official State Marching Band Contest portal. Current-season prelims+finals for all 6 conferences as **inline static HTML** (12 `<tbody id="{Prelims|Finals}{1A..6A}">` blocks in index.htm, toggled by JS — data is in the page source, no AJAX). Judge-ordinal rankings + total (5-judge Music1-3/Visual1-2 for 4A–6A, 7-judge panel for 1A–3A). |
| State archives | https://www.smbc.uiltexas.org/archives.htm | One DataTables `<table id="archives">`, ~4,100 static rows: Year / Conference / Round / Place / School(ISD), **1979–2024**. Plain inline HTML, one fetch. |
| State leaderboard | https://smbc.uiltexas.org/leaderboard.htm | Championships/finals-appearance counts per school, inline HTML (233 KB). |
| Area contests | Hosted on ~10 region sites (linked from /music/marching-band/area, e.g. region1music.com, uilregion8music.com) | Rankings/advancement posted per-site, typically as PDFs. No central source. |
| Region websites | ~33 independent domains listed at https://www.uiltexas.org/music/region-area/executive-secretaries | Mixed Wix/Weebly sites; marching results as unnamed-GUID PDFs (verified on https://www.region1music.com/contest-results — per-year "Region 1 Marching 16..24" PDF links). |

### Data mechanism — the two that matter

**A. Texas Music Forms CSV endpoint (region layer, whole state, one GET per year):**

```
https://www.texasmusicforms.com/marchuilpubliccsv.asp?yr=2024&connum=ALL&rg=ALL&ev=x&get=go
```

- Verified: HTTP 200, `text/csv`, clean header
  `School,City,Region,Director,Asst Director,Classification,NV,Conference,Contest,Contest Date,Score 1,Score 2,Score 3,Final Score,Judge 1,Judge 2,Judge 3`
- 2024 = **1,063 bands** (645 Division I, 224 II, 34 III …). 2005 = 896 bands.
- Year dropdown on the report form covers **2005–2026** — 22 seasons, each a single CSV GET.
- HTML report equivalent: POST `yr=&reg=ALL&connum=ALL&get=go` to `marchrptuilpublic.asp` (1.4 MB inline HTML, same data). Discovered CSV URL from the page's own `downloadCSV()` JS.
- Semantics note: UIL region marching awards **Division ratings (1–5)**, not point scores. Area/state use ordinal rankings. So the app's UIL views should be ratings/advancement-shaped, not score-trend-shaped (matches the existing Cadence UIL app model).

**B. SMBC portal (state layer):** static inline HTML for current season; archives.htm for 1979–2024 placements. Trivial regex/DOM parse; the index page even self-reloads on update during championships (`modify-check.php`), so polling it during the Nov contest gives near-live state results.

### Historical depth
- Region ratings: 2005–2026 via CSV (verified 2005 and 2024 both return data).
- State placements: 1979–2024 in archives.htm (verified inline).
- State judge-ordinal detail: current season only on the live page; per-year detail links
  (http://utdirect.utexas.edu/uilsmbc/ltwa_archive.WBX?s_year=2009..2017) now redirect to
  **UT EID login — gated/dead** (verified). Wayback has yearly index captures back to 2018
  (CDX verified) but off-season snapshots are small — ordinal backfill via Wayback is
  possible-but-unverified, and non-essential.

### Blockers
- None for the two primary sources: no login, no JS-only rendering (SMBC data is in page source; TMF is a plain ASP form + CSV endpoint), no anti-bot encountered from this sandbox.
- Area-contest layer is the only messy part (33 sites, PDF-per-contest, GUID filenames) — skippable at first; region CSV + state HTML bracket it.
- texasmusicforms.com is a vendor site (CutTime LLC) with standard ToS; the report page is explicitly the public-facing "Official Marching Contest Results". One GET per year is negligible load.

### Demand evidence (not sources)
- TxBands.com forum threads compiling "UIL Every State Result 2025" (https://www.txbands.com/forums/topic/17523-...)
- Wikipedia "List of Texas UIL State Marching Band Competition Winners"; local-news recaps (kxan.com).

### Verdict: **BUILDABLE (S)** — arguably the best effort-to-audience ratio of any circuit probed
One CSV GET per year covers every UIL region band in Texas (~1,000+/season, 22 seasons), plus a
trivial static-HTML parse of smbc.uiltexas.org for state prelims/finals + 45 years of placements.
Two small parsers, no new infrastructure. Largest scholastic marching audience in the country.

---

## 2. MSBA — Mid-States Band Association (~100 bands, OH/KY/IN)

### Official site
- **Correct domain is https://www.midstatesba.org/** (Squarespace). The domain given in the
  task brief, midstatesband.org, does **not resolve** (WebFetch: `getaddrinfo ENOTFOUND`;
  proxy CONNECT 502; zero Wayback CDX captures — it was never the site).
- Nav: `/2026schedule` (~20 show host pages + per-class championship pages), `/pastresults`, `/about`, `/resources`.

### Data mechanism — CompetitionSuite, GUID found and bridge-verified
- https://www.midstatesba.org/pastresults embeds the CompetitionSuite orgscores widget:
  `<div data-compsuite-org='92ef7a21-7f50-423c-bc56-e29bf359baf7'>` + `bridge.competitionsuite.com/orgscores/orgscores.js`.
- **Bridge tested from this sandbox — works end-to-end:**
  - `GetSeasons?organization=92ef7a21-...` → **8 seasons, 2018–2025** (season GUIDs returned).
  - `GetCompetitionsBySeason?season=79273f22-...` (2025) → **31 competitions** (2021: 28; 2018: 2 — partial first year).
  - `GetCompetition?competition=790950bb-...` → rounds with `fullRecapUrl` =
    `http://recaps.competitionsuite.com/1595b947-b08f-46b3-ad6a-0fc79d00a5c7.htm` **and**
    inline performances with name/score/rank (e.g. 2025 Class AAAA Championships Prelims:
    Kings HS 85.3, South Oldham 83.8, …).
  - Recap page itself fetched: HTTP 200, 135 KB — the exact judge-level format
    `scraper/scrape_compsuite.py` already parses.
- Pre-2018 history: http://old.midstatesba.org/2005/2005.htm … /2018/2018.htm — plain old
  HTML archives, reachable (2018 page: 200, 177 KB). Gap: 2007 missing from the link list.

### Blockers
- None. Bridge and recaps are open; the Squarespace page only needed a one-time GUID extraction.
- The direct site fetch works with plain curl (Squarespace serves full HTML server-side).

### Verdict: **LIVE-READY**
Existing CompetitionSuite parser + a known org GUID = point it and go. 8 seasons (2018–2025),
~30 shows/season with judge-level recaps, real point scores. Audience is modest (~100 bands
across OH/KY/IN) but marginal cost is near zero since the parser already exists.

---

## Summary table

| Circuit | Mechanism | History | Blockers | Verdict |
|---|---|---|---|---|
| UIL Texas (region layer) | texasmusicforms.com public CSV endpoint, 1 GET/year | 2005–2026, ~900–1,060 bands/yr | none (ratings not scores — model accordingly) | **BUILDABLE (S)** |
| UIL Texas (state SMBC) | Inline static HTML on smbc.uiltexas.org (+archives.htm) | live ordinals current yr; placements 1979–2024 | pre-2018 ordinal detail gated behind UT EID | **BUILDABLE (S)** (same parser pass) |
| UIL Texas (area layer) | PDFs scattered across ~33 region Wix sites | varies | GUID filenames, per-site chaos | NOT-WORTH-IT initially (bracketed by region CSV + state HTML) |
| MSBA | CompetitionSuite bridge, org GUID `92ef7a21-7f50-423c-bc56-e29bf359baf7` (verified live) | 2018–2025 bridge; 2005–2018 plain HTML at old.midstatesba.org | none; note real domain is midstatesba.org | **LIVE-READY** |
