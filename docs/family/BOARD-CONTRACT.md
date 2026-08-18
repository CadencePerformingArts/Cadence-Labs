# Scoreboard shapes

## Why a second board exists at all

The DCI scoreboard leads with a season progression chart: score by date, one
line per corps. That reads well because a DCI corps performs about ten times
a summer against the same field — measured on the live dataset, 92% of corps
have three or more scored appearances in a season, so a line has something to
say.

WGI is the opposite case. WGI publishes its live scores through a
directors-only portal, so Cadence has **no season score feed for it at all**:
what is openly published is the championship record and the official event
schedule. A progression chart over zero scores is not a thin chart, it is a
lie. So those apps declare a different board and render a purpose-built
module instead.

| App | board | what the home board shows |
|-----|-------|---------------------------|
| DCI (`docs/app.js`, the root app) | `trend` | season progression + standings |
| WGI Color Guard / Percussion / Winds | `history` | championship record + official schedule |

`trend` is the default and never reaches this file — it is the DCI app's own
`viewRankings`. `history` is the only shape `board.js` implements.

> Three further shapes once lived here — `event` (BOA), `rating` (UIL) and
> `placement` (ISSMA) — along with the Division-rating/placement engine that
> fed them. Those circuits were retired and the shapes deleted with them.
> Do not reintroduce a ratings or placement code path; no shipping app has
> results that are anything but point scores.

## `CadBoard.render({ app, data, stale, shape, cfg, helpers })`

Called from the derived engine's `viewRankings` (see
`scripts/build_family_engine.py`, transform `board shape hook`) before the
standings board is built, whenever `APP_CFG.board` is set to anything other
than `"trend"`.

- `app` — the `<main>` element to render into.
- `data(path)` — the engine's cached fetcher, relative to this app's `data/`.
  Rejects on a missing file; the board must `.catch()` anything optional.
- `stale()` — returns true when the reader navigated away; bail out.
- `shape` — `"history"`. Anything else renders the "couldn't load" card.
- `cfg` — the full `APP_CFG` (`classOrder`, `terms`, `ns`, `captions`, …).
- `helpers` — `{ esc, h, score3, corpsLink, corpsLogo, sortClasses, fmtDate2,
  FAVS, ensureLogos }` from the engine, so output matches the rest of Cadence.

`render` never throws: a failure inside a shape becomes an in-page card.

## What `history` reads

All three files are fetched together and each degrades on its own:

| file | used for | missing → |
|------|----------|-----------|
| `champions.json` | reigning champions, honor roll, dynasties | tiles and both tables drop out, schedule still renders |
| `corps_index.json` | the "ensembles tracked" tile | tile reads 0 |
| `upcoming.json` | the official schedule list | "the next season's schedule lands here when WGI publishes it" |

`champions.json` is `{ "<year>": { "<class>": { "corps": str, "score": num|null } } }`.
`upcoming.json` is a list of `{ name, date, location?, date_display? }`.

Scores are optional throughout — WGI's published record carries champions
without scores for many seasons, and the board prints `—` rather than
inventing one.

## Styling

`board.js` injects `board.css` itself, resolved against its own `src`, so an
app shell only ever loads one `<script>`. Everything else — cards, tables,
tabs, `.tscroll`, `.expandwrap`, `.empty` — comes from `app.css`, and
`.champ-*` from `family/family.css`.

One rule worth keeping: `.bd-tiles` sets its column count **in board.css, not
in an inline style on the element**. Pinned inline at four columns, the
640px breakpoint can never win and the tiles clip their own labels on a
phone.
