import type { ModeDefinition, ScoreSystem } from '../types';

const scScoring: ScoreSystem = {
  id: 'sc-event',
  name: 'Event-defined scoring',
  max: 100,
  precision: 1,
  unit: 'score',
};

/**
 * Show choir has no national governing body: every invitational defines its
 * own divisions and scoring, so results are strictly per-event and divisions
 * are event-scoped categories rather than a universal system.
 */
export const showchoir: ModeDefinition = {
  id: 'showchoir',
  name: 'Show Choir',
  shortName: 'Show Choir',
  icon: '🎭',
  accent: '#16a34a',
  tagline: 'Invitationals, finals nights and caption awards.',
  terminology: {
    ensemble: 'Choir',
    ensemblePlural: 'Choirs',
    event: 'Invitational',
    eventPlural: 'Events',
    scoreboard: 'Results',
  },
  segments: [
    {
      id: 'sc-season',
      name: 'Competition Season',
      divisions: [
        { id: 'mixed', name: 'Mixed', short: 'MIXED', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-event' },
        { id: 'treble', name: 'Treble', short: 'TREBLE', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-event' },
        { id: 'smallschool', name: 'Small School', short: 'SMALL', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-event' },
        { id: 'largeschool', name: 'Large School', short: 'LARGE', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-event' },
        { id: 'middleschool', name: 'Middle School', short: 'MS', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-event' },
        { id: 'festival', name: 'Festival (non-competitive)', short: 'FEST', scoreSystemId: scScoring.id, comparabilityGroup: 'sc-festival' },
      ],
      scoreSystems: [scScoring],
      defaultDivisionIds: ['mixed', 'treble', 'smallschool', 'largeschool'],
      rankingBehavior: 'eventBased',
      rounds: ['Prelims', 'Finals'],
      advancement: true,
    },
  ],
  defaultSegmentId: 'sc-season',
  screens: ['scoreboard', 'events', 'ensembles', 'favorites', 'more'],
  features: { captions: true, historical: false, predictions: false, brackets: false },
  dataStatus: 'fixture',
  dataSourceNote:
    'Fixture data for demonstration. No compliant national source exists; real data arrives via verified admin import per event.',
  emptyState: 'No invitationals scored yet this season.',
};
