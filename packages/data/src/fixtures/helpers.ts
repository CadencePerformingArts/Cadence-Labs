import type {
  CompetitionEvent,
  Ensemble,
  ModeId,
  Performance,
  Provenance,
  StandingRow,
  TrendPoint,
} from '@cadence/domain';

export function fixtureProvenance(sourceName: string): Provenance {
  return {
    sourceId: 'fixture',
    sourceName,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    kind: 'fixture',
  };
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function ensemble(
  modeId: ModeId,
  segmentId: string,
  divisionId: string,
  name: string,
  location?: string,
): Ensemble {
  return { id: slug(name), modeId, segmentId, divisionId, name, location };
}

/** Build a results session from [name, division, score, extras] tuples, ranked per division-comparable table. */
export function results(
  rows: Array<{
    name: string;
    divisionId: string;
    score?: number;
    points?: number;
    awards?: string[];
    advanced?: boolean;
    captions?: Array<{ caption: string; score: number }>;
  }>,
): Performance[] {
  const ranked = [...rows].sort(
    (a, b) => (b.score ?? b.points ?? 0) - (a.score ?? a.points ?? 0),
  );
  return ranked.map((r, i) => ({
    ensembleId: slug(r.name),
    ensembleName: r.name,
    divisionId: r.divisionId,
    score: r.score,
    points: r.points,
    rank: i + 1,
    awards: r.awards,
    advanced: r.advanced,
    captions: r.captions,
  }));
}

/** Derive a season-leaderboard from the latest score per ensemble across events. */
export function standingsFromEvents(
  events: CompetitionEvent[],
  divisionIds: string[],
): StandingRow[] {
  const latest = new Map<string, { row: StandingRow; date: string; trend: TrendPoint[] }>();
  const scored = events
    .filter((e) => !e.upcoming)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const event of scored) {
    for (const session of event.sessions) {
      for (const perf of session.results) {
        const value = perf.score ?? perf.points;
        if (!divisionIds.includes(perf.divisionId) || value === undefined) continue;
        const prev = latest.get(perf.ensembleId);
        const trend = prev ? [...prev.trend, { date: event.date, score: value }] : [{ date: event.date, score: value }];
        latest.set(perf.ensembleId, {
          date: event.date,
          trend,
          row: {
            ensembleId: perf.ensembleId,
            name: perf.ensembleName,
            divisionId: perf.divisionId,
            rank: 0,
            score: value,
            delta: prev ? +(value - prev.row.score).toFixed(3) : undefined,
            lastEvent: event.name,
            lastDate: event.date,
            outings: trend.length,
            trend,
          },
        });
      }
    }
  }
  const rows = [...latest.values()]
    .map((v) => v.row)
    .sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
