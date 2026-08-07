import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpsCentralRankingsAdapter, type CorpsCentralRankings } from '../adapters/corpsCentralRankings';

/**
 * Contract test: the adapter must accept what the live pipeline currently
 * publishes. It runs against the real docs/data/rankings.json committed by
 * the twice-daily scrape, so a silent format change in the source breaks CI
 * instead of silently publishing garbage.
 */
const rankingsPath = resolve(__dirname, '../../../../docs/data/rankings.json');
const raw = JSON.parse(readFileSync(rankingsPath, 'utf8')) as CorpsCentralRankings;

describe('corps central rankings contract', () => {
  it('parses the live pipeline output without errors', () => {
    const result = corpsCentralRankingsAdapter.parse(raw);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('produces sane normalized standings', () => {
    const { data } = corpsCentralRankingsAdapter.parse(raw);
    expect(data).toBeDefined();
    expect(data!.season).toBeGreaterThanOrEqual(2026);
    expect(Object.keys(data!.standings)).toContain('world');
    for (const rows of Object.values(data!.standings)) {
      for (const row of rows) {
        expect(row.score).toBeGreaterThanOrEqual(0);
        expect(row.score).toBeLessThanOrEqual(100);
        expect(row.ensembleId).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('rejects a payload with impossible scores', () => {
    const poisoned: CorpsCentralRankings = {
      generated: raw.generated,
      season: raw.season,
      standings: {
        'World Class': { rows: [{ corps: 'Bad Corps', score: 250, rank: 1 }] },
      },
    };
    const result = corpsCentralRankingsAdapter.parse(poisoned);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/outside 0–100/);
  });

  it('warns loudly about unknown classes instead of dropping them silently', () => {
    const changed: CorpsCentralRankings = {
      generated: raw.generated,
      season: raw.season,
      standings: {
        'Brand New Class': { rows: [{ corps: 'Someone', score: 80, rank: 1 }] },
      },
    };
    const result = corpsCentralRankingsAdapter.parse(changed);
    expect(result.warnings.join(' ')).toMatch(/source may have changed/);
  });
});
