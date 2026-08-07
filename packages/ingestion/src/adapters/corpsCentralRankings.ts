import type { Provenance, StandingRow } from '@cadence/domain';
import type { AdapterResult, SourceAdapter } from '../types';

/**
 * Adapter for the legacy Corps Central pipeline output (docs/data/
 * rankings.json), which is itself built from DCI.org / Competition Suite.
 * This is the bridge between the existing Python scrapers and the new data
 * model: scripts/gen_dci_snapshot.py uses the same shape, and when Supabase
 * arrives this adapter feeds the upsert step instead of a JSON file.
 */

export interface CorpsCentralRankings {
  generated: string;
  season: number;
  standings: Record<string, { rows: CorpsCentralRow[] }>;
}

export interface CorpsCentralRow {
  corps: string;
  score: number;
  date?: string;
  event?: string;
  delta?: number | null;
  outings?: number;
  trend?: Array<[string, number]>;
  rank: number;
}

const DIVISION_BY_CLASS: Record<string, string> = {
  'World Class': 'world',
  'Open Class': 'open',
  'All-Age': 'allage',
  International: 'intl',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface NormalizedRankings {
  season: number;
  standings: Record<string, StandingRow[]>;
}

function validateRow(cls: string, row: CorpsCentralRow, errors: string[]): void {
  const where = `${cls} / ${row.corps ?? '?'}`;
  if (!row.corps || typeof row.corps !== 'string') errors.push(`${where}: missing corps name`);
  if (typeof row.score !== 'number' || row.score < 0 || row.score > 100) {
    errors.push(`${where}: score ${row.score} outside 0–100`);
  }
  if (row.date && !ISO_DATE.test(row.date)) errors.push(`${where}: bad date ${row.date}`);
  for (const point of row.trend ?? []) {
    if (!ISO_DATE.test(point[0]) || typeof point[1] !== 'number') {
      errors.push(`${where}: malformed trend point ${JSON.stringify(point)}`);
      break;
    }
  }
}

export const corpsCentralRankingsAdapter: SourceAdapter<CorpsCentralRankings, NormalizedRankings> = {
  sourceId: 'dci-org-snapshot',
  modeId: 'dci',

  provenance(fetchedAt: string): Provenance {
    return {
      sourceId: this.sourceId,
      sourceName: 'DCI.org via Corps Central pipeline',
      url: 'https://www.dci.org/scores',
      fetchedAt,
      kind: 'snapshot',
    };
  },

  parse(raw: CorpsCentralRankings): AdapterResult<NormalizedRankings> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!raw || typeof raw !== 'object') {
      return { ok: false, errors: ['payload is not an object'], warnings };
    }
    if (typeof raw.season !== 'number') errors.push('missing season');
    if (!raw.standings || typeof raw.standings !== 'object') errors.push('missing standings');
    if (errors.length > 0) return { ok: false, errors, warnings };

    const standings: Record<string, StandingRow[]> = {};
    for (const [cls, block] of Object.entries(raw.standings)) {
      const divisionId = DIVISION_BY_CLASS[cls];
      if (!divisionId) {
        // A class name we've never seen usually means the source changed —
        // surface it loudly instead of silently dropping data.
        warnings.push(`unknown class "${cls}" — source may have changed`);
        continue;
      }
      const rows = block.rows ?? [];
      rows.forEach((row) => validateRow(cls, row, errors));
      const ranks = rows.map((r) => r.rank);
      for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] !== i + 1) {
          errors.push(`${cls}: ranks not sequential at position ${i}`);
          break;
        }
      }
      standings[divisionId] = rows.map((row) => ({
        ensembleId: row.corps
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, ''),
        name: row.corps,
        divisionId,
        rank: row.rank,
        score: row.score,
        delta: row.delta ?? undefined,
        lastEvent: row.event,
        lastDate: row.date,
        outings: row.outings,
        trend: (row.trend ?? []).map(([date, score]) => ({ date, score })),
      }));
    }

    if (Object.keys(standings).length === 0) {
      errors.push('no recognizable classes in payload');
    }
    return { ok: errors.length === 0, data: errors.length === 0 ? { season: raw.season, standings } : undefined, errors, warnings };
  },
};
