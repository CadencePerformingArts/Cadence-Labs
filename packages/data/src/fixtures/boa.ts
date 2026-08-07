/**
 * Bands of America fixture season — demonstration data only. Bands are real,
 * well-known programs; scores and placements are invented to exercise the
 * BOA structure: per-event results (no national league table), Prelims →
 * Finals advancement, class champions and caption awards.
 */
import type { CompetitionEvent, Ensemble } from '@cadence/domain';
import { ensemble, fixtureProvenance, results } from './helpers';

export const boaProvenance = fixtureProvenance('Cadence fixture data (BOA demo season)');

const bands: Array<[string, string, string]> = [
  ['Carmel HS', 'aaaa', 'Carmel, IN'],
  ['Avon HS', 'aaaa', 'Avon, IN'],
  ['Broken Arrow HS', 'aaaa', 'Broken Arrow, OK'],
  ['Hebron HS', 'aaaa', 'Carrollton, TX'],
  ['Flower Mound HS', 'aaaa', 'Flower Mound, TX'],
  ['Vandegrift HS', 'aaaa', 'Austin, TX'],
  ['Blue Springs HS', 'aaaa', 'Blue Springs, MO'],
  ['Bentonville HS', 'aaaa', 'Bentonville, AR'],
  ['Marian Catholic HS', 'aaa', 'Chicago Heights, IL'],
  ['Claudia Taylor Johnson HS', 'aaa', 'San Antonio, TX'],
  ['Rockford HS', 'aaa', 'Rockford, MI'],
  ['Owasso HS', 'aaa', 'Owasso, OK'],
  ['Union HS', 'aa', 'Tulsa, OK'],
  ['Bourbon County HS', 'aa', 'Paris, KY'],
  ['Adair County HS', 'a', 'Columbia, KY'],
  ['Western Carteret HS', 'a', 'Cape Carteret, NC'],
];

export const boaEnsembles: Ensemble[] = bands.map(([name, cls, loc]) =>
  ensemble('boa', 'boa-season', cls, name, loc),
);

function spread(base: number, names: Array<[string, string, string]>, jitter: number) {
  return names.map(([name, cls], i) => ({
    name,
    divisionId: cls,
    score: +(base - i * 0.85 + (i % 3) * jitter).toFixed(2),
  }));
}

function championship(
  id: string,
  name: string,
  date: string,
  city: string,
  venue: string,
  lineup: Array<[string, string, string]>,
  finalsBase: number,
): CompetitionEvent {
  const prelims = spread(finalsBase - 2.2, lineup, 0.21);
  const finalists = [...prelims].sort((a, b) => b.score - a.score).slice(0, Math.min(10, lineup.length));
  const classWinner = new Map<string, string>();
  for (const p of [...prelims].sort((a, b) => b.score - a.score)) {
    if (!classWinner.has(p.divisionId)) classWinner.set(p.divisionId, p.name);
  }
  return {
    id,
    modeId: 'boa',
    segmentId: 'boa-season',
    name,
    date,
    city,
    venue,
    sessions: [
      {
        id: `${id}-prelims`,
        name: 'Prelims',
        order: 1,
        results: results(
          prelims.map((p) => ({
            ...p,
            advanced: finalists.some((f) => f.name === p.name),
            awards: classWinner.get(p.divisionId) === p.name ? [`Class ${p.divisionId.toUpperCase()} Champion`] : undefined,
          })),
        ),
      },
      {
        id: `${id}-finals`,
        name: 'Finals',
        order: 2,
        results: results(
          finalists.map((p, i) => ({
            name: p.name,
            divisionId: p.divisionId,
            score: +(p.score + 1.9 - i * 0.12).toFixed(2),
            awards:
              i === 0
                ? ['Grand Champion', 'Outstanding Music Performance']
                : i === 1
                  ? ['Outstanding Visual Performance']
                  : i === 2
                    ? ['Outstanding General Effect']
                    : undefined,
          })),
        ),
      },
    ],
  };
}

export const boaEvents: CompetitionEvent[] = [
  championship(
    'boa-2026-stgeorge',
    'BOA St. George Regional Championship',
    '2026-09-26',
    'St. George, UT',
    'Greater Zion Stadium',
    bands.slice(4, 12),
    88.5,
  ),
  championship(
    'boa-2026-sanantonio',
    'BOA San Antonio Super Regional Championship',
    '2026-10-24',
    'San Antonio, TX',
    'Alamodome',
    bands.filter(([, , loc]) => loc.includes('TX') || loc.includes('OK') || loc.includes('AR')),
    92.3,
  ),
  championship(
    'boa-2026-grandnats',
    'Bands of America Grand National Championships',
    '2026-11-14',
    'Indianapolis, IN',
    'Lucas Oil Stadium',
    bands,
    94.1,
  ),
  {
    id: 'boa-2027-stgeorge-upcoming',
    modeId: 'boa',
    segmentId: 'boa-season',
    name: 'BOA St. George Regional Championship (2027)',
    date: '2027-09-25',
    city: 'St. George, UT',
    sessions: [],
    upcoming: true,
    lineup: bands.slice(0, 8).map(([n]) => n),
  },
];
