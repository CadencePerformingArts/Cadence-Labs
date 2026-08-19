# Cadence design language

The reference for anyone building a Cadence screen. Everything here is read
out of the shipped `docs/app.css` — if this file and the stylesheet disagree,
the stylesheet is right and this file is stale.

Cadence was rebased onto DCI-Tracker's design in August 2026 (see the commit
"Rebase onto DCI-Tracker's design"). The single biggest thing that changed:
**Cadence now has a desktop layout.** Before the rebase every `@media` rule in
`app.css` was `max-width`, so above 640px the whole product was one stretched
column — a phone build blown up. New screens must not reintroduce that.

## The breakpoint that matters

```css
@media (min-width: 700px) { … }
```

700, not 1000. The comment in `app.css` explains why: the 641–999px range
"used to be a dead zone that looked like neither phone nor desktop". A phone
held sideways is ~670–930px, and portrait tablets land there too. Anything
that only becomes two-column at 1000px leaves that whole band stranded.

`560px` is the secondary breakpoint, used for the year panel and the
onboarding chip grid.

## Layout primitives

Use these before writing a new grid.

| Class | What it does |
|---|---|
| `.dsk2` | Stacks on phones, two equal columns at ≥700px. The default way to pair two cards. |
| `.dsk2.w75` | Same, but 7fr / 5fr — a wide primary beside a narrower secondary. |
| `.rk-grid` | The scoreboard shell. Named areas `trend`, `move`, `battle`, `stand`: chart left, two summary cards stacked right, standings full-width beneath. |
| `#corpsDetail` | The profile shell: `minmax(360px, 5fr) 7fr`, areas `hero chart / filters chart / perf champs / tiles tiles / prof prof`. |
| `#evlist` | Two show cards per row; section labels and expanders span both columns. |

Two rules that come with them:

* `.dsk2 > *`, `.rk-grid > *` carry `min-width: 0`, so a wide table scrolls
  **inside** its card instead of stretching the whole track. Any new grid
  needs the same, or one wide table will blow out the page.
* `.dsk2[hidden]` is explicitly re-hidden, because `display: grid` otherwise
  defeats the `hidden` attribute.

## Surfaces

* `.card` — the standard container. `.card.cardgap` when stacking cards
  outside a grid.
* `.tile` — a smaller stat/nav box; `.tile.click` makes it a target.
* `.setcard` — a settings card; capped at 640px on its own, uncapped inside
  `.dsk2`.
* `.corpshero` / `.corpshero-stats` — the identity block. Four stat tiles at
  desktop, two at ≤640px, and two again inside `#corpsDetail` because it
  shares its row with the chart.

## Tokens

Never hardcode a colour. The full set defined in `app.css`:

```
--page  --surface-1  --surface-2  --border  --baseline  --grid
--text-primary  --text-secondary  --heading  --muted  --link
--navy  --gold  --accent  --accent-ink  --accent-wash
--good  --bad  --mono
--series-1 … --series-8          (categorical, for charts)
--ch-grid --ch-base --ch-label --ch-ink --ch-halo --ch-cross
```

`--muted` was darkened in the rebase to meet AA contrast (≥4.5:1) on both
light surfaces. Do not lighten it back for aesthetics.

## Charts

`window.CCViz` exports `lineChart`, `barChart`, `sparkline`, `PALETTE`, `esc`,
`showTip`, `hideTip`. Two things every chart drawn outside `charts.js` must
reuse rather than reimplement:

* **`fitWidth(container)`** — the SVG is sized `width: 100%` and scaled by its
  viewBox, so a hardcoded width renders 11px axis text at 4px on a phone.
* **`lineColor(hex)`** — lifts any colour below a 0.32 luminance floor toward
  white in dark mode. Without it, dark identity colours vanish on the dark
  chart surface.

## Mobile

Mobile-first is still the floor, not the ceiling. Every screen must work
one-handed at 390px **and** use the space it is given at 1280px. The checks
that catch regressions: no page may scroll horizontally, and no element may
clip its own content unless it is a deliberate `text-overflow: ellipsis`.

A grid column declared `minmax(0, 1fr)` may shrink below its content, so long
unbreakable words run out through the card border — add `overflow-wrap:
anywhere` to labels that can contain one. And never pin a responsive grid with
an inline `style="grid-template-columns:…"`: an inline style outranks the
stylesheet, so the phone rule silently never applies. That exact mistake
clipped the WGI championship tiles to "Championshi".

## The workspace side

`docs/ensemble/` has its own `ensemble.css` for workspace chrome (the section
rail, sheets, the notification bell). It layers **on top of** `app.css` and
uses the same tokens and the same `.card` / `.tile` surfaces. It is not a
second design system, and a workspace screen should reach for `.dsk2` and the
grid primitives above before inventing a layout.
