# The championship board

## What replaced the bespoke board

There used to be a second scoreboard here — `board.js` (14 KB) plus
`board.css` and a `CadBoard.render({app, data, stale, shape, cfg, helpers})`
plugin contract — because the DCI scoreboard leads with a season progression
chart and WGI has no season to progress: WGI publishes live scores only
through its directors-only portal, so Cadence has no per-show score feed for
it at all.

That module is gone. **Both files are deleted, and so is the `APP_CFG.board`
shape plumbing in `scripts/build_family_engine.py`.** Three things changed:

1. Five of the six circuits the plugin contract existed to serve (BOA, US
   Bands, UIL, WGASC, TCGC, FFCC) were retired, and their `event` / `rating` /
   `placement` shapes with them. A plugin architecture with one plugin is
   overhead, not flexibility.
2. `scripts/build_wgi_datasets.py` now fans the championship record out into
   the shapes the shared engine already reads (`corps_index.json`,
   `corps/<slug>.json`, `records.json`, `rankings.json`, `db/*`). Three of the
   four things the old board rendered — the honor roll, the dynasty count and
   the official schedule — are now the **Champions**, **Records** and
   **Shows** tabs: real screens with filters, search, deep links, CSV export
   and share cards, instead of a read-only copy of them on one page.
3. What was left is one branch of one view, so it lives in the engine, where
   it shares `.rk-grid`, the tokens, `multiSelect`, `wireYearPicker`,
   `lineChart` and the rest by construction rather than by convention.

## How the board is chosen now

By the data, not by config. `docs/wgi/*/data/rankings.json` carries

```json
{ "kind": "championship", "season": 2026, "standings": {…}, "winners": {…} }
```

and the derived engine's `viewRankings` reads that file first:

```js
if (FAM) {
  const rkc = await data("rankings.json").catch(() => null);
  if (rkc && rkc.kind === "championship") return champBoard(qs, stale, rkc);
}
```

(see `scripts/build_family_engine.py`, transform `board shape hook`). The day
WGI grants portal access and `.github/workflows/wgi-ingest.yml` ingests real
per-show scores, `build_wgi_datasets.py` refuses the tree — see
`refusal_reason()` — a normal `rankings.json` is written without
`kind: "championship"`, and the DCI board takes over. No code change here.

## What `champBoard` renders

The same shell as the DCI board: the year picker in the `<h1>`, the `.rk-grid`
with its four named areas, the same cards and tables.

| area | DCI | championship |
|---|---|---|
| `trend` | season progression, score by date | **winning score by season**, one line per class — 236 real title scores for guard |
| `stand` | standings, each corps' latest score | **the selected season's World Championships**: champion, score, title # and previous title, one row per class |
| `move` | Biggest Move (latest vs previous show) | **Biggest Move**: the selected season's winning score against the previous championship in the same class |
| `battle` | Closest Battle (smallest gap) | **Dynasties** (most titles in the charted classes) |

The year picker offers every season with a title on record (1978–2026 for
guard), so `#/?y=1985` is the 1985 World Championships. `#/season/1985`
redirects there instead of to a Shows page that has no 1985.

Two rules the board keeps:

* **Nothing is interpolated.** Consecutive-season logic (`Biggest Jump`)
  refuses to span a gap in the record, and the chart's sub-line names the
  gaps out loud ("no championships 2020–21").
* **One honest sentence per screen.** `APP_CFG.notes` carries a one-liner per
  screen (`board`, `events`, `corps`, `compare`, `records`, `database`,
  `profile`), written in `scripts/gen_family_pages.py` and rendered by the
  engine's `noteHtml()`. The board's says why there are no season scores. An
  app that shows an empty column has to say why, once — not on every card.

## The dataset contract

`scripts/build_wgi_datasets.py` is the only writer of these five files in a
WGI tree, and every row in them is one championship title (place 1, one class,
one season). It asserts that itself — `assert_traceable()` walks every derived
row back to a `champions.json` entry and raises rather than write a row that
cannot be traced — and `scripts/test_wgi_datasets.js` re-checks it from
outside.

| file | shape | used by |
|---|---|---|
| `corps_index.json` | `[{name, slug, first, last, seasons, best, n, series:[[year, score, class]]}]` | Ensembles, Compare |
| `corps/<slug>.json` | `{name, performances:[{y, d, ev, cls, p, s}]}` | ensemble profiles |
| `records.json` | `{class: {top:[[y, date, corps, score, event]], finals:{year:[[corps, score]]}}}` | Stats › Records |
| `rankings.json` | `{kind, season, standings:{class:{rows}}, winners:{class:[[y, corps, score]]}}` | Scoreboard, My Cadence |
| `db/index.json`, `db/perfs_<decade>.json` | `[[year, date, event, corps, class, place, score]]` | Stats › Database |

**`date` is null everywhere**, because the published record carries no dates.
The views fall back to the year (`fmtDate2(null, year)`), the profile drops
its within-season progression chart for the career view, and `my.js` skips
undated rows. A plausible-looking championship date would be exactly the kind
of invention `scripts/purge_fabricated.py` exists to clean up.

`champions.json` itself is untouched and remains the source of truth:
`{"<year>": {"<class>": {"corps": str, "score": num|null}}}`.

Two operational notes:

* **One writer per tree.** `scripts/gen_family_data.py` (the deploy and ingest
  path) asks `build_wgi_datasets.refusal_reason()` first: no reason → the
  champion derivation writes these files; a reason → its own season-file
  derivation does, and the champion builder stands down.
* `scripts/purge_fabricated.py --rebuild` still resets these five files to the
  empty state. It predates this derivation and decides "this app has no real
  results" by counting season results only, which a championship record has
  none of. It is a manual tool, no workflow runs it, and it never touches
  `champions.json` — so re-running `python3 scripts/build_wgi_datasets.py`
  (or `gen_family_data.py`) puts everything back, byte for byte.
