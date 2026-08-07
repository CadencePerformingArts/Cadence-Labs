# Cadence — Product Vision

Cadence is a year-round scoreboard and fan app for competitive musical and performing
arts. Scores in these activities are scattered across circuit websites, PDFs, and
Facebook posts. Cadence puts them in one fast, beautiful app — with the correct
vocabulary, divisions, and ranking logic for each activity, so it never feels like a
generic sports app with the labels swapped.

One app, five activities, twelve months of season. When drum corps ends in August,
marching band ramps up; when band ends, winter guard and percussion begin; a cappella
and show choir run through the winter and spring. A fan of one activity is usually a
fan of two or three.

## The five modes

Every mode uses the shared navy/gold Cadence shell, but each is purpose-built:

- **DCI (Drum Corps International).** Season-long leaderboard with score trends,
  full event recaps with captions, and a champions timeline back to 1972. Corps,
  Shows, Scoreboard. World and Open Class can share a table; All-Age and
  International never mix in. Runs on real data today (see below).
- **WGI (Sport of the Arts).** Three activities — Color Guard, Percussion, and
  Winds — each with Scholastic/Independent classes at A, Open, and World levels.
  Classes are judged separately and are never combined into one ranked table.
  Ensembles, Regionals, Scoreboard.
- **Bands of America.** Regionals, Super Regionals, and Grand Nationals. Results
  are event-scoped: there is no official season league table, so Cadence presents
  results per event with Prelims/Finals rounds and advancement. Bands,
  Regionals/Championships, Results.
- **Competitive A Cappella (ICCA / ICHSA / The Open).** A tournament: groups earn
  points within a round (quarterfinal, semifinal, finals) and advance by region.
  Rankings only make sense within one round of one event. Groups, Competitions.
- **Show Choir.** Hundreds of independent local invitationals with no national
  circuit. Event-scoped results by classification (Mixed, Treble, school size),
  plus grand champions and caption awards. Choirs, Competitions, Results.

## Real data vs. demo data

- **DCI is real today**: a snapshot generated from the long-running Corps Central
  scrape of DCI.org — 2026 season standings with trends, 67 events, and champions
  back to 1972 — refreshed on every web deploy.
- **WGI, BOA, A Cappella, and Show Choir run on labeled fixture data**: real
  ensemble names with invented scores, always marked with a "DEMO DATA" badge.
  Cadence never presents demo data as live results; the UI and the test suite
  both enforce this.

## Free vs. Cadence+ (sketch)

Free tier — the whole scoreboard, always:
- All modes, all scores, all events, champions history.
- Favorites and basic score notifications.

Cadence+ (paid subscription, priced later — see docs/monetization.md):
- Advanced analytics: trend charts, caption breakdowns, head-to-head comparisons.
- Richer notifications (per-caption, per-rival, recap alerts).
- Season recap / "Wrapped"-style features, early access to new modes.
- No ads (if ads are ever introduced to free; none exist today).

Principle: the score itself is never paywalled. Cadence+ sells depth and
convenience, not access to results.

## Personas

- **The fan.** Follows several corps or groups, checks scores the moment a show
  ends, argues about placements. Wants speed, trends, and push alerts.
- **The alum.** Marched or sang years ago; loves the champions timeline,
  historical scores, and "on this day" nostalgia. Checks in weekly, spikes at
  finals.
- **The parent.** Has a kid in one specific ensemble. Wants that group's schedule,
  their next event, and their result tonight — with zero jargon in the way.
- **The staff member / director.** Needs accurate caption-level recaps quickly
  after a show, and comparisons against the ensembles they will meet next week.
  The most demanding user of correctness and provenance labels.

## What Cadence is not

- Not a ticketing, streaming, or media app.
- Not an official product of DCI, WGI, Music for All, Varsity Vocals, or any
  circuit — it is an unofficial fan project and says so.
- Not a place where fabricated numbers ever masquerade as real results.
