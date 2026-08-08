# Scoreboard shapes + the insights contract

## Why circuits need different boards

Measured from the real datasets (latest scored season, performances per
ensemble / share with 3+ appearances):

| App | ens | events | perf/ens | 3+ | verdict |
|-----|-----|--------|----------|-----|---------|
| DCI | 53 | 61 | 10.0 | 92% | trend lines are the right answer |
| WGASC | 497 | 48 | 4.6 | 95% | trends work |
| FFCC | 264 | 27 | 4.7 | 95% | trends work |
| TCGC | 407 | 39 | 4.0 | 89% | trends work |
| US Bands | 454 | 128 | 3.1 | 43% | trends work for many |
| **BOA** | **679** | **29** | **1.3** | **6%** | a season line is one dot — needs event-centric + multi-season |
| **UIL** | **1052** | **60** | **1.2** | **5%** | ratings, not scores — needs rating history |
| **ISSMA** | **51** | **2** | **1.0** | **0%** | placements only |

So each app declares `APP_CFG.board`: `trend` (default, DCI behaviour),
`event`, `rating`, or `placement`. Non-trend boards render through
`docs/family/board.js` (`window.CadBoard.render(...)`), called from the
engine's `viewRankings` before the standings board is built.

## `CadBoard.render({ app, data, stale, shape, cfg, helpers })`

- `app` — the `<main>` element to render into.
- `data(path)` — the engine's cached fetcher, relative to this app's `data/`.
- `stale()` — returns true when the user navigated away; bail out.
- `shape` — `"event" | "rating" | "placement"`.
- `cfg` — the full `APP_CFG` (classOrder, terms, scoreNote, resultsKind…).
- `helpers` — `{ esc, h, score3, corpsLink, corpsLogo, sortClasses, fmtDate2,
  FAVS, ensureLogos }` from the engine, so output matches the rest of Cadence.

## `data/insights.json` (precomputed by `scripts/gen_insights.py`)

Written per app. Every key is optional — `board.js` must degrade to whatever
exists and never assume a section is present.

```jsonc
{
  "shape": "event",
  "updated": "2026-08-08 04:00 UTC",
  "latest_year": 2025,
  "seasons": [1976, ..., 2025],

  // most recent events, newest first (event boards lead with these)
  "recent_events": [{
    "name": "BOA Grand National Championships",
    "date": "2025-11-15", "location": "Indianapolis, IN",
    "classes": [{
      "class": "Class AAAA", "n": 18, "median": 72.1,
      "top": [{"corps": "Carmel HS (IN)", "score": 96.15, "rank": 1}]
    }]
  }],

  // best score per ensemble this season, per class (honest label: panels differ)
  "season_leaders": {
    "Class AAAA": [{"corps": "…", "best": 96.15, "best_event": "…",
                    "best_date": "2025-11-15", "events": 3}]
  },

  // multi-season trajectory: [year, best score] — this IS a real trend even
  // when a single season isn't (BOA has up to 49 points per band)
  "trajectory": { "Carmel HS (IN)": [[2019, 94.2], [2021, 95.0]] },

  // biggest year-over-year movement (risers/fallers module)
  "yoy": [{"corps": "…", "class": "…", "from": 88.1, "to": 93.4,
           "delta": 5.3, "years": [2024, 2025]}],

  // score spread per class per season, for "where did we land" context
  "class_dist": { "Class AAAA": { "2025": {"min": 55.2, "p25": 68.0,
                   "median": 72.1, "p75": 80.4, "max": 96.15, "n": 210} } },

  // caption averages by class + season (only where captions exist)
  "captions": { "Class AAAA": { "2025": {"ge": 27.4, "vis": 22.1, "mus": 23.0} } },

  // UIL: division-rating distribution per class per year, and per-band history
  "ratings": { "6A": { "2025": {"1": 180, "2": 60, "3": 12} } },
  "band_ratings": { "Akins HS": [[2024, 2], [2025, 1]] },

  // ISSMA: placement history per band
  "placements": { "Avon HS": [[2024, 1], [2025, 2]] }
}
```

Rules: never invent numbers. UIL ratings are 1–5 (1 = Superior), so lower is
better and averages are meaningless — show distributions and streaks, not
means. ISSMA placements are ordinals; lower is better. Score-based circuits
must label any cross-event comparison as such, because panels differ.
