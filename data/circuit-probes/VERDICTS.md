# Circuit data research — consolidated verdicts

All 10 requested circuits probed (4 research agents, every mechanism below
**tested live from this sandbox** unless noted). Detailed per-circuit reports
sit beside this file: `texas-uil-msba.md`, `issma.md`, `winterguard-west.md`,
`winterguard-east.md`.

**Verdict key**
- **LIVE-READY** — real scores reachable today with the existing
  CompetitionSuite parser (`scraper/scrape_compsuite.py`); effort is wiring,
  not research.
- **BUILDABLE (S/M)** — real public data exists but needs a bespoke parser
  (Small / Medium effort).
- **NOT-WORTH-IT** — data is hard-gated or too fragmented to obtain
  ethically/reliably.

## Ranked verdicts (user's requested order)

| # | Circuit | Verdict | Data reachable today | History | Notes |
|---|---------|---------|----------------------|---------|-------|
| 1 | **UIL Texas** (marching band, ~1,000 bands/yr) | **BUILDABLE (S)** | texasmusicforms.com public CSV — one GET per year, whole state | Ratings 2005–2026; state placements 1979–2024 (smbc.uiltexas.org inline HTML) | UIL publishes **division ratings (1–5), not point scores** — the app would be ratings + state placements, which is still the only statewide view anywhere. Area-contest layer NOT-WORTH-IT (PDF chaos across ~33 Wix sites). |
| 2 | **ISSMA** (Indiana, ~150–200 bands) | **BUILDABLE (S)** placements-only; scores **NOT-WORTH-IT** | mbhistory.php — placements 1973–2025 on one public page | 1973–2025 | Every scored result is behind a Directors-Only login (gated since 2005). Big audience, no obtainable scores. **Bonus finds:** Indiana's *winter* circuits are wide open — see IHSCGA + IPA below. |
| 3 | **WGASC** (SoCal winter guard, ~300+ guards — biggest winter circuit) | **LIVE-READY (S)** | CompetitionSuite bridge — 2025 + 2026 season GUIDs verified (41 + 48 comps) | 2021–2026 on bridge; 2004–2011 in Wayback | Their website is captcha-walled from the sandbox but the bridge + recaps are NOT. Seed via season GUIDs. |
| 4 | **TCGC** (Texas winter guard, ~200+) | **LIVE-READY (S)** | 302 recap GUIDs harvested; 7 seasons resolved live (2014–2024) | 2014–2024 today; 2025/26 needs one seed GUID | Real domain is texascolorguardcircuit.org (tcgc.org is a gun club). |
| 5 | **FFCC** (Florida, ~220 teams incl. percussion + winds) | **LIVE-READY (S)** | Bridge seasons 2024/2025/2026 verified (25/30/27 comps) | 2024–2026 bridge; 2015–2019 inline HTML in Wayback | Adds percussion + winds coverage in the Southeast. |
| 6 | **SCGC** (Southeastern winter guard, ~177) | **BUILDABLE (S)** | Recap GUIDs enumerated from public results.php; verified resolving on bridge | 2008–2026 | No org GUID exposed — harvest per-event GUIDs instead. |
| 7 | **CWEA** (Carolinas, ~150+) | **LIVE-READY** | Org GUID `D8D4A509-BA34-43FD-84D1-5DBBEDBC2F5D` tested — 13 seasons | 2014–2026 | Cleanest of the bunch: full org walk with the existing parser. |
| 8 | **MEPA** (Ohio, ~100+) | **BUILDABLE (M)** | Recap verified on bridge; site itself sits behind a SiteGround proof-of-work gate | 2015–2026 | Data is fine; discovering *new* event GUIDs each week is the medium-effort part. |
| 9 | **MCGC** (Michigan, ~100+) | **LIVE-READY** | Org GUID `E8F964B9-13B1-4B46-8F38-3FD61D8BB498` tested — 14 seasons | 2013–2026 | Full org walk, existing parser. |
| 10 | **MSBA** (Mid-States fall band) | **LIVE-READY** | Org GUID `92ef7a21-7f50-423c-bc56-e29bf359beb7`* tested — GetSeasons → recaps end-to-end | 2018–2025 bridge; 2005–2018 plain HTML at old.midstatesba.org | *See texas-uil-msba.md for exact GUID. Real domain is midstatesba.org. |

## Bonus circuits found during research (not on the original list)

| Circuit | Verdict | Why it matters |
|---------|---------|----------------|
| **IHSCGA** (Indiana HS winter guard) | **LIVE-READY** — org GUID `219C70AB-66F9-462B-AB0A-86A4B4F62CB5` tested, 16 seasons 2013–2026 | Replaces the gated ISSMA-scores dead end for Indiana winter fans. |
| **IPA** (Indiana Percussion Assoc — percussion + winds) | **LIVE-READY** — org GUID `c196feef-4f95-4d62-a146-95b892a58f0a` tested, 2017–2026 | Same. |
| **MCCGA** (Mid Continent, ~100+) | **BUILDABLE (S)** — recap GUIDs verified; archives to 1996 | Deepest history of any winter circuit probed. |

## Recommended build order

Wire-up cost is lowest and payoff highest for the CompetitionSuite org-GUID
circuits, so: **CWEA → MCGC → MSBA → IHSCGA/IPA** (pure parser reuse), then
**WGASC → TCGC → FFCC** (season/recap-GUID seeding), then **SCGC → MCCGA**
(GUID harvesting), then **MEPA** (gate workaround), then **UIL Texas** as the
one bespoke build (ratings model differs from scores). **ISSMA scores: skip**
— placements-only page can ride along with the Indiana winter apps later.

Every one of these publishes caption-level recaps through CompetitionSuite,
so the winter-circuit apps get **real caption breakdowns** (the Cadence+
headline feature) — something WGI national events do not publicly expose.
