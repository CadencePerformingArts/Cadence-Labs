/**
 * Show choir fixture season — demonstration data only. Choirs are real,
 * well-known programs; scores and events are invented to exercise the
 * per-event structure with event-defined divisions and caption awards.
 */
import type { CompetitionEvent, Ensemble } from '@cadence/domain';
import { ensemble, fixtureProvenance, results } from './helpers';

export const scProvenance = fixtureProvenance('Cadence fixture data (Show Choir demo season)');

const choirs: Array<[string, string, string]> = [
  ['John Burroughs “Powerhouse”', 'mixed', 'Burbank, CA'],
  ['Carmel “Ambassadors”', 'mixed', 'Carmel, IN'],
  ['Waubonsie Valley “Sound Check”', 'mixed', 'Aurora, IL'],
  ['Los Alamitos “Sound FX”', 'mixed', 'Los Alamitos, CA'],
  ['Clinton “Attaché”', 'smallschool', 'Clinton, MS'],
  ['Petal “Innovations”', 'smallschool', 'Petal, MS'],
  ['Carmel “Accents”', 'treble', 'Carmel, IN'],
  ['John Burroughs “Sound Sensations”', 'treble', 'Burbank, CA'],
  ['Sartell “Chain Reaction”', 'largeschool', 'Sartell, MN'],
  ['Totino-Grace “Company of Singers”', 'largeschool', 'Fridley, MN'],
];

export const scEnsembles: Ensemble[] = choirs.map(([name, div, loc]) =>
  ensemble('showchoir', 'sc-season', div, name, loc),
);

function invitational(
  id: string,
  name: string,
  date: string,
  city: string,
  lineup: Array<[string, string, number]>,
  finalsLift: number,
): CompetitionEvent {
  const finalists = [...lineup].sort((a, b) => b[2] - a[2]).slice(0, Math.min(6, lineup.length));
  return {
    id,
    modeId: 'showchoir',
    segmentId: 'sc-season',
    name,
    date,
    city,
    sessions: [
      {
        id: `${id}-prelims`,
        name: 'Prelims',
        order: 1,
        results: results(
          lineup.map(([choir, div, score]) => ({
            name: choir,
            divisionId: div,
            score,
            advanced: finalists.some(([f]) => f === choir),
          })),
        ),
      },
      {
        id: `${id}-finals`,
        name: 'Finals',
        order: 2,
        results: results(
          finalists.map(([choir, div, score], i) => ({
            name: choir,
            divisionId: div,
            score: +(score + finalsLift - i * 0.4).toFixed(1),
            awards:
              i === 0
                ? ['Grand Champion', 'Best Vocals']
                : i === 1
                  ? ['Best Choreography']
                  : i === 2
                    ? ['Best Band']
                    : undefined,
          })),
        ),
      },
    ],
  };
}

export const scEvents: CompetitionEvent[] = [
  invitational(
    'sc-2026-heart-of-america',
    'Heart of America Show Choir Classic',
    '2026-01-24',
    'Kansas City, MO',
    [
      ['Carmel “Ambassadors”', 'mixed', 94.2],
      ['Waubonsie Valley “Sound Check”', 'mixed', 92.8],
      ['Sartell “Chain Reaction”', 'largeschool', 90.1],
      ['Totino-Grace “Company of Singers”', 'largeschool', 89.3],
      ['Carmel “Accents”', 'treble', 91.5],
      ['Clinton “Attaché”', 'smallschool', 92.2],
    ],
    2.1,
  ),
  invitational(
    'sc-2026-fame-chicago',
    'FAME Show Choir National Championship — Chicago',
    '2026-03-14',
    'Chicago, IL',
    [
      ['John Burroughs “Powerhouse”', 'mixed', 95.0],
      ['Los Alamitos “Sound FX”', 'mixed', 93.6],
      ['Carmel “Ambassadors”', 'mixed', 94.6],
      ['John Burroughs “Sound Sensations”', 'treble', 92.4],
      ['Petal “Innovations”', 'smallschool', 91.0],
      ['Clinton “Attaché”', 'smallschool', 92.9],
    ],
    1.8,
  ),
  {
    id: 'sc-2027-heart-of-america-upcoming',
    modeId: 'showchoir',
    segmentId: 'sc-season',
    name: 'Heart of America Show Choir Classic (2027)',
    date: '2027-01-23',
    city: 'Kansas City, MO',
    sessions: [],
    upcoming: true,
    lineup: choirs.slice(0, 5).map(([n]) => n),
  },
];
