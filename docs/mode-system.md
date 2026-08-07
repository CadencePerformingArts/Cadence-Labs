# The Mode System

The mode system (`packages/domain`) is how one app serves five very different
activities without becoming a lowest-common-denominator sports app. Everything
the UI needs to know about an activity lives in a typed `ModeDefinition`; the
screens are generic and read from it.

## The shape of a mode

Defined in `packages/domain/src/types.ts`, instances in
`packages/domain/src/modes/*.ts`, registered in the mode registry.

```
ModeDefinition (dci, wgi, boa, acappella, showchoir)
└── Segment[]            sub-competition with its own circuit & scoring
    ├── Division[]       classes judged separately
    │   └── comparabilityGroup   which divisions may share one table
    ├── ScoreSystem[]    max score, precision, score vs points
    ├── rankingBehavior  seasonLeaderboard | eventBased | tournament
    └── rounds / advancement     Prelims → Finals, who advances
```

- **Segment** — a sub-competition inside a mode. WGI has three (Color Guard,
  Percussion, Winds — the third activity is Winds, never "Brass"); A Cappella
  has ICCA, ICHSA, and The Open. Single-circuit modes (DCI, BOA, Show Choir)
  have one default segment.
- **Division** — a class judged on its own: DCI World Class, WGI Scholastic A,
  BOA Class AAAA. Each names its score system and its comparability group.

## comparabilityGroup — the anti-nonsense rule

Divisions may only appear together in one ranked table when they share a
`comparabilityGroup`. This encodes what is competitively meaningful:

- **DCI:** World and Open Class both use group `dci-field`, so they can be
  combined (they compete at the same shows). All-Age (`dci-allage`) and
  International (`dci-intl`) each stand alone.
- **WGI:** every class gets its own group (`wgi-guard-cg-sw`, ...). Classes are
  never combined — Independent World and Scholastic A scores are not comparable.
- **BOA:** all classes share `boa-event` — comparable, but only within a single
  event (see rankingBehavior below).
- **ICCA/ICHSA:** groups are per-round (`icca-round`), because points only rank
  performances within one round of one competition.
- **Show Choir:** classifications share `sc-event` (event-scoped); Festival is
  non-competitive and isolated in `sc-festival`.

Tests in `packages/domain/src/__tests__/comparability.test.ts` enforce these
rules; a change that lets incomparable divisions merge fails CI.

## Terminology

Each mode carries a `Terminology` object so screens speak the right language:
Corps vs. Bands vs. Ensembles vs. Groups vs. Choirs; Shows vs. Regionals vs.
Competitions; Scoreboard vs. Standings vs. Results. The generic screens read
these strings — nobody hardcodes "Corps" into a shared component.

## rankingBehavior — what the main surface is

- **`seasonLeaderboard`** (DCI, WGI): a season-long ranked table of latest
  scores with trend/delta per ensemble. Drives the Scoreboard tab as the
  primary surface; event pages show individual recaps.
- **`eventBased`** (BOA, Show Choir): no legitimate cross-event league table
  exists, so the Events list is effectively the front door; each event page
  shows its Prelims/Finals sessions, placements, and awards. The scoreboard
  surface shows event results, never a fake season ranking.
- **`tournament`** (ICCA/ICHSA): rounds and regions with advancement. Event
  pages rank by points within one round; the season surface tracks who has
  advanced toward finals rather than a score table.

## Other fields the UI reads

- `screens`: which tabs the mode shows (scoreboard, events, ensembles,
  favorites, more).
- `features`: captions, historical archive, predictions, brackets — flags that
  light up optional UI.
- `dataStatus` + `dataSourceNote`: live / snapshot / fixture, surfaced by the
  `FreshnessBadge` in `packages/ui`. Fixture modes always show DEMO DATA.
- `icon`, `accent`, `tagline`, `emptyState`: mode flavor layered on the shared
  navy/gold shell.

## Adding or changing a mode

See `docs/adding-a-mode.md` for the step-by-step. The short version: define the
mode file, add fixtures, register it, add registry + comparability tests — and
every generic screen works immediately.
