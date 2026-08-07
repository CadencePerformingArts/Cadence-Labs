import type { Division, ModeDefinition, ScoreSystem, Segment } from '../types';

const wgiScoring: ScoreSystem = {
  id: 'wgi-100',
  name: 'WGI 100-point system',
  max: 100,
  precision: 3,
  unit: 'score',
};

/**
 * WGI divisions are source-defined and vary by season; this list mirrors the
 * commonly published classes. Scholastic and Independent units, and different
 * classes (A / Open / World), are judged separately and never combined.
 */
function classes(prefix: string, group: string): Division[] {
  const mk = (id: string, name: string, short: string): Division => ({
    id,
    name,
    short,
    scoreSystemId: wgiScoring.id,
    comparabilityGroup: `${group}-${id}`,
  });
  return [
    mk(`${prefix}-sa`, 'Scholastic A', 'SA'),
    mk(`${prefix}-so`, 'Scholastic Open', 'SO'),
    mk(`${prefix}-sw`, 'Scholastic World', 'SW'),
    mk(`${prefix}-ia`, 'Independent A', 'IA'),
    mk(`${prefix}-io`, 'Independent Open', 'IO'),
    mk(`${prefix}-iw`, 'Independent World', 'IW'),
  ];
}

const rounds = ['Prelims', 'Semifinals', 'Finals'];

const colorGuard: Segment = {
  id: 'guard',
  name: 'Color Guard',
  shortName: 'Guard',
  divisions: classes('cg', 'wgi-guard'),
  scoreSystems: [wgiScoring],
  defaultDivisionIds: ['cg-iw'],
  rankingBehavior: 'seasonLeaderboard',
  rounds,
  advancement: true,
};

const percussion: Segment = {
  id: 'percussion',
  name: 'Percussion',
  shortName: 'Perc',
  divisions: [
    ...classes('pc', 'wgi-perc'),
    {
      id: 'pc-concert',
      name: 'Concert Percussion',
      short: 'PCO',
      scoreSystemId: wgiScoring.id,
      comparabilityGroup: 'wgi-perc-concert',
    },
  ],
  scoreSystems: [wgiScoring],
  defaultDivisionIds: ['pc-iw'],
  rankingBehavior: 'seasonLeaderboard',
  rounds,
  advancement: true,
};

/** The third WGI activity is Winds — never "Brass". */
const winds: Segment = {
  id: 'winds',
  name: 'Winds',
  divisions: classes('wd', 'wgi-winds'),
  scoreSystems: [wgiScoring],
  defaultDivisionIds: ['wd-iw'],
  rankingBehavior: 'seasonLeaderboard',
  rounds,
  advancement: true,
};

export const wgi: ModeDefinition = {
  id: 'wgi',
  name: 'WGI Sport of the Arts',
  shortName: 'WGI',
  icon: '🚩',
  accent: '#7c3aed',
  tagline: 'Color Guard, Percussion and Winds — regionals to Championships.',
  terminology: {
    ensemble: 'Ensemble',
    ensemblePlural: 'Ensembles',
    event: 'Regional',
    eventPlural: 'Events',
    scoreboard: 'Scoreboard',
  },
  segments: [colorGuard, percussion, winds],
  defaultSegmentId: 'guard',
  screens: ['scoreboard', 'events', 'ensembles', 'favorites', 'more'],
  features: { captions: true, historical: true, predictions: false, brackets: false },
  dataStatus: 'fixture',
  dataSourceNote:
    'Fixture data for demonstration. WGI has not published a live feed for this build; see docs/data-sources.md.',
  emptyState: 'No results for this class yet this season.',
};
