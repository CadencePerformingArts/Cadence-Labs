import type { ModeDefinition } from '../types';

const dciScoring = {
  id: 'dci-100',
  name: 'DCI 100-point system',
  max: 100,
  precision: 3,
  unit: 'score' as const,
};

/**
 * DCI: World and Open Class share a judging sheet and may be combined into
 * one table; All-Age and International are judged on separate panels and are
 * standalone choices.
 */
export const dci: ModeDefinition = {
  id: 'dci',
  name: 'Drum Corps International',
  shortName: 'DCI',
  icon: '🥁',
  accent: '#d97706',
  tagline: 'Live season standings, complete score history back to 1972.',
  terminology: {
    ensemble: 'Corps',
    ensemblePlural: 'Corps',
    event: 'Show',
    eventPlural: 'Shows',
    scoreboard: 'Scoreboard',
  },
  segments: [
    {
      id: 'dci-tour',
      name: 'DCI Tour',
      divisions: [
        { id: 'world', name: 'World Class', short: 'WORLD', scoreSystemId: dciScoring.id, comparabilityGroup: 'dci-field' },
        { id: 'open', name: 'Open Class', short: 'OPEN', scoreSystemId: dciScoring.id, comparabilityGroup: 'dci-field' },
        { id: 'allage', name: 'All-Age', short: 'ALL-AGE', scoreSystemId: dciScoring.id, comparabilityGroup: 'dci-allage' },
        { id: 'intl', name: 'International', short: 'INTL', scoreSystemId: dciScoring.id, comparabilityGroup: 'dci-intl' },
      ],
      scoreSystems: [dciScoring],
      defaultDivisionIds: ['world'],
      rankingBehavior: 'seasonLeaderboard',
      rounds: ['Prelims', 'Semifinals', 'Finals'],
      advancement: true,
    },
  ],
  defaultSegmentId: 'dci-tour',
  screens: ['scoreboard', 'events', 'ensembles', 'favorites', 'more'],
  features: { captions: true, historical: true, predictions: true, brackets: false },
  dataStatus: 'snapshot',
  dataSourceNote:
    'Snapshot of the 2026 season from DCI.org (Competition Suite) via the Corps Central pipeline.',
  emptyState: 'No scores yet — the season kicks off in late June.',
};
