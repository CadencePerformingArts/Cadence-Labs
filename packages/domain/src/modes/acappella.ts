import type { ModeDefinition, ScoreSystem, Segment } from '../types';

const iccaScoring: ScoreSystem = {
  id: 'vv-points',
  name: 'Varsity Vocals judged points',
  max: 500,
  precision: 0,
  unit: 'points',
};

const tournamentRounds = ['Quarterfinal', 'Semifinal', 'Finals'];

function tournamentSegment(id: string, name: string, shortName: string): Segment {
  return {
    id,
    name,
    shortName,
    divisions: [
      {
        id: `${id}-open`,
        name: 'Open',
        short: 'OPEN',
        scoreSystemId: iccaScoring.id,
        comparabilityGroup: `${id}-round`,
      },
    ],
    scoreSystems: [iccaScoring],
    defaultDivisionIds: [`${id}-open`],
    rankingBehavior: 'tournament',
    rounds: tournamentRounds,
    advancement: true,
  };
}

/**
 * Competitive a cappella is a bracketed tournament (regions → quarterfinals →
 * semifinals → finals), not a season leaderboard: point totals only rank
 * groups within a single round of a single event.
 */
export const acappella: ModeDefinition = {
  id: 'acappella',
  name: 'Competitive A Cappella',
  shortName: 'A Cappella',
  icon: '🎤',
  accent: '#0891b2',
  tagline: 'ICCA and ICHSA — from regional quarterfinals to the Finals stage.',
  terminology: {
    ensemble: 'Group',
    ensemblePlural: 'Groups',
    event: 'Competition',
    eventPlural: 'Competitions',
    scoreboard: 'Tournament',
  },
  segments: [
    tournamentSegment('icca', 'ICCA (Collegiate)', 'ICCA'),
    tournamentSegment('ichsa', 'ICHSA (High School)', 'ICHSA'),
    tournamentSegment('vvopen', 'The Open', 'Open'),
  ],
  defaultSegmentId: 'icca',
  screens: ['scoreboard', 'events', 'ensembles', 'favorites', 'more'],
  features: { captions: false, historical: true, predictions: false, brackets: true },
  dataStatus: 'fixture',
  dataSourceNote:
    'Fixture data for demonstration. Varsity Vocals results would require permission or verified import; see docs/data-sources.md.',
  emptyState: 'This bracket has not started yet.',
};
