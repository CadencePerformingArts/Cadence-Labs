import { describe, expect, it } from 'vitest';
import { MODES, getMode, getSegment } from '@cadence/domain';
import { FixtureProvider } from '../fixtureProvider';

const provider = new FixtureProvider();

describe('fixture provider integrity', () => {
  it('serves standings for every mode default segment', async () => {
    for (const mode of MODES) {
      const segment = getSegment(mode, mode.defaultSegmentId);
      const standings = await provider.getStandings(
        mode.id,
        segment.id,
        segment.defaultDivisionIds,
      );
      expect(standings.rows.length).toBeGreaterThan(0);
      expect(standings.rows[0].rank).toBe(1);
      const scores = standings.rows.map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
  });

  it('refuses to combine incomparable divisions', async () => {
    await expect(
      provider.getStandings('dci', 'dci-tour', ['world', 'allage']),
    ).rejects.toThrow(/incomparable/i);
  });

  it('DCI data is a real snapshot with provenance; other modes are labeled fixtures', async () => {
    const dci = await provider.getProvenance('dci');
    expect(dci.kind).toBe('snapshot');
    expect(dci.url).toContain('dci.org');
    for (const modeId of ['wgi', 'boa', 'acappella', 'showchoir'] as const) {
      const p = await provider.getProvenance(modeId);
      expect(p.kind).toBe('fixture');
      expect(getMode(modeId).dataStatus).toBe('fixture');
    }
  });

  it('every result references a division defined in its segment', async () => {
    for (const mode of MODES) {
      const events = await provider.getEvents(mode.id);
      for (const event of events) {
        const segment = getSegment(mode, event.segmentId);
        const divisionIds = new Set(segment.divisions.map((d) => d.id));
        for (const session of event.sessions) {
          for (const result of session.results) {
            expect(divisionIds.has(result.divisionId), `${event.id}: ${result.divisionId}`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it('every scored performer resolves to a known ensemble', async () => {
    for (const mode of MODES) {
      const known = new Set((await provider.getEnsembles(mode.id)).map((e) => e.id));
      const events = await provider.getEvents(mode.id);
      for (const event of events) {
        for (const session of event.sessions) {
          for (const result of session.results) {
            expect(known.has(result.ensembleId), `${event.id}: ${result.ensembleId}`).toBe(true);
          }
        }
      }
    }
  });

  it('ICCA rounds rank by points, not scores', async () => {
    const events = await provider.getEvents('acappella', 'icca');
    const scored = events.filter((e) => !e.upcoming);
    expect(scored.length).toBeGreaterThan(0);
    for (const event of scored) {
      for (const result of event.sessions[0].results) {
        expect(result.points).toBeGreaterThan(0);
        expect(result.score).toBeUndefined();
      }
    }
  });

  it('sessions are ordered rounds (prelims before finals)', async () => {
    const events = await provider.getEvents('boa');
    for (const event of events.filter((e) => !e.upcoming)) {
      const orders = event.sessions.map((s) => s.order);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      expect(event.sessions[0].name).toBe('Prelims');
      expect(event.sessions[event.sessions.length - 1].name).toBe('Finals');
    }
  });

  it('upcoming events carry lineups but no results', async () => {
    for (const mode of MODES) {
      const events = await provider.getEvents(mode.id);
      const upcoming = events.filter((e) => e.upcoming);
      expect(upcoming.length).toBeGreaterThan(0);
      for (const event of upcoming) expect(event.sessions.length).toBe(0);
    }
  });
});
