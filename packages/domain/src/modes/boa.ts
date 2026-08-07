import type { ModeDefinition, ScoreSystem } from '../types';

const boaScoring: ScoreSystem = {
  id: 'boa-100',
  name: 'BOA 100-point system',
  max: 100,
  precision: 2,
  unit: 'score',
};

/**
 * Bands of America results are per-event: each regional/super-regional and
 * Grand Nationals has its own judging panel, so scores from different events
 * are never merged into one national league table (rankingBehavior:
 * 'eventBased'). Classes A–AAAA compete for class awards within an event and
 * all bands compete together in finals, so classes share one comparability
 * group within an event.
 */
export const boa: ModeDefinition = {
  id: 'boa',
  name: 'Bands of America',
  shortName: 'BOA',
  icon: '🎺',
  accent: '#dc2626',
  tagline: 'Regionals, Super Regionals and Grand Nationals.',
  terminology: {
    ensemble: 'Band',
    ensemblePlural: 'Bands',
    event: 'Championship',
    eventPlural: 'Championships',
    scoreboard: 'Results',
  },
  segments: [
    {
      id: 'boa-season',
      name: 'BOA Championships',
      divisions: [
        { id: 'a', name: 'Class A', short: 'A', scoreSystemId: boaScoring.id, comparabilityGroup: 'boa-event' },
        { id: 'aa', name: 'Class AA', short: 'AA', scoreSystemId: boaScoring.id, comparabilityGroup: 'boa-event' },
        { id: 'aaa', name: 'Class AAA', short: 'AAA', scoreSystemId: boaScoring.id, comparabilityGroup: 'boa-event' },
        { id: 'aaaa', name: 'Class AAAA', short: 'AAAA', scoreSystemId: boaScoring.id, comparabilityGroup: 'boa-event' },
      ],
      scoreSystems: [boaScoring],
      defaultDivisionIds: ['a', 'aa', 'aaa', 'aaaa'],
      rankingBehavior: 'eventBased',
      rounds: ['Prelims', 'Finals'],
      advancement: true,
    },
  ],
  defaultSegmentId: 'boa-season',
  screens: ['scoreboard', 'events', 'ensembles', 'favorites', 'more'],
  features: { captions: true, historical: true, predictions: false, brackets: false },
  dataStatus: 'fixture',
  dataSourceNote:
    'Fixture data for demonstration. Results are shown per event; BOA publishes no national ranking and Cadence does not invent one.',
  emptyState: 'No championships scored yet this season.',
};
