/**
 * Competitive a cappella fixture season — demonstration data only. Groups are
 * real, well-known programs; points, placements and events are invented to
 * exercise the tournament structure: regional quarterfinals → semifinals →
 * Finals, ranked by judged points within a single round only.
 */
import type { CompetitionEvent, Ensemble } from '@cadence/domain';
import { ensemble, fixtureProvenance, results } from './helpers';

export const acaProvenance = fixtureProvenance('Cadence fixture data (ICCA/ICHSA demo season)');

const iccaGroups: Array<[string, string, string]> = [
  ['The SoCal VoCals', 'West', 'University of Southern California'],
  ['The Nor’easters', 'Northeast', 'Northeastern University'],
  ['Pitch Slapped', 'Northeast', 'Berklee College of Music'],
  ['Voices in Your Head', 'Midwest', 'University of Chicago'],
  ['Fundamentally Sound', 'Midwest', 'University of Wisconsin'],
  ['The Melodores', 'South', 'Vanderbilt University'],
  ['Reverb', 'South', 'University of Georgia'],
  ['Vocal Point', 'Southwest', 'Brigham Young University'],
  ['The Hullabahoos', 'Mid-Atlantic', 'University of Virginia'],
  ['Off the Beat', 'Mid-Atlantic', 'University of Pennsylvania'],
];

const ichsaGroups: Array<[string, string, string]> = [
  ['Forte', 'Midwest', 'Centerville HS'],
  ['Limited Edition', 'Midwest', 'Homestead HS'],
  ['Vocal Fusion', 'Northeast', 'Millburn HS'],
  ['Highland Voices', 'South', 'Highland Park HS'],
];

export const acaEnsembles: Ensemble[] = [
  ...iccaGroups.map(([name, , school]) => ({
    ...ensemble('acappella', 'icca', 'icca-open', name, school),
  })),
  ...ichsaGroups.map(([name, , school]) => ({
    ...ensemble('acappella', 'ichsa', 'ichsa-open', name, school),
  })),
];

function round(
  id: string,
  segmentId: string,
  divisionId: string,
  name: string,
  date: string,
  city: string,
  region: string | undefined,
  entries: Array<[string, number]>,
  advanceCount: number,
  awards?: Record<string, string[]>,
): CompetitionEvent {
  return {
    id,
    modeId: 'acappella',
    segmentId,
    name,
    date,
    city,
    region,
    sessions: [
      {
        id: `${id}-results`,
        name: 'Results',
        order: 1,
        results: results(
          entries.map(([group, points], i) => ({
            name: group,
            divisionId,
            points,
            advanced: i < advanceCount,
            awards: awards?.[group],
          })),
        ),
      },
    ],
  };
}

export const acaEvents: CompetitionEvent[] = [
  round(
    'icca-2026-ne-quarter',
    'icca',
    'icca-open',
    'ICCA Northeast Quarterfinal',
    '2026-02-07',
    'Boston, MA',
    'Northeast',
    [
      ['The Nor’easters', 438],
      ['Pitch Slapped', 431],
      ['Vocal Fusion', 356],
    ],
    2,
    { 'The Nor’easters': ['Outstanding Vocal Percussion'] },
  ),
  round(
    'icca-2026-west-quarter',
    'icca',
    'icca-open',
    'ICCA West Quarterfinal',
    '2026-02-14',
    'Los Angeles, CA',
    'West',
    [
      ['The SoCal VoCals', 452],
      ['Vocal Point', 447],
    ],
    2,
    { 'The SoCal VoCals': ['Outstanding Choreography'] },
  ),
  round(
    'icca-2026-mw-quarter',
    'icca',
    'icca-open',
    'ICCA Midwest Quarterfinal',
    '2026-02-21',
    'Chicago, IL',
    'Midwest',
    [
      ['Voices in Your Head', 441],
      ['Fundamentally Sound', 428],
    ],
    2,
  ),
  round(
    'icca-2026-ne-semi',
    'icca',
    'icca-open',
    'ICCA Northeast Semifinal',
    '2026-03-21',
    'New York, NY',
    'Northeast',
    [
      ['The Nor’easters', 449],
      ['Pitch Slapped', 440],
    ],
    1,
    { 'Pitch Slapped': ['Outstanding Arrangement'] },
  ),
  round(
    'icca-2026-west-semi',
    'icca',
    'icca-open',
    'ICCA West Semifinal',
    '2026-03-28',
    'Berkeley, CA',
    'West',
    [
      ['The SoCal VoCals', 455],
      ['Vocal Point', 451],
    ],
    1,
  ),
  round(
    'icca-2026-mw-semi',
    'icca',
    'icca-open',
    'ICCA Midwest Semifinal',
    '2026-03-28',
    'Chicago, IL',
    'Midwest',
    [
      ['Voices in Your Head', 446],
      ['Fundamentally Sound', 433],
    ],
    1,
  ),
  round(
    'icca-2026-finals',
    'icca',
    'icca-open',
    'ICCA Finals',
    '2026-04-25',
    'New York, NY',
    undefined,
    [
      ['The SoCal VoCals', 462],
      ['The Nor’easters', 458],
      ['Voices in Your Head', 449],
    ],
    0,
    {
      'The SoCal VoCals': ['ICCA Champion'],
      'The Nor’easters': ['Outstanding Vocal Percussion'],
    },
  ),
  round(
    'ichsa-2026-mw-quarter',
    'ichsa',
    'ichsa-open',
    'ICHSA Midwest Quarterfinal',
    '2026-02-28',
    'Dayton, OH',
    'Midwest',
    [
      ['Forte', 421],
      ['Limited Edition', 412],
    ],
    2,
  ),
  round(
    'ichsa-2026-finals',
    'ichsa',
    'ichsa-open',
    'ICHSA Finals',
    '2026-05-02',
    'New York, NY',
    undefined,
    [
      ['Forte', 444],
      ['Limited Edition', 431],
      ['Vocal Fusion', 425],
      ['Highland Voices', 410],
    ],
    0,
    { Forte: ['ICHSA Champion'] },
  ),
  {
    id: 'icca-2027-ne-quarter-upcoming',
    modeId: 'acappella',
    segmentId: 'icca',
    name: 'ICCA Northeast Quarterfinal (2027 season)',
    date: '2027-02-06',
    city: 'Boston, MA',
    region: 'Northeast',
    sessions: [],
    upcoming: true,
    lineup: ['The Nor’easters', 'Pitch Slapped'],
  },
];
