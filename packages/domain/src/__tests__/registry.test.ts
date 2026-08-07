import { describe, expect, it } from 'vitest';
import { MODES, getMode, getSegment } from '../registry';

describe('mode registry', () => {
  it('contains the five launch modes', () => {
    expect(MODES.map((m) => m.id)).toEqual(['dci', 'wgi', 'boa', 'acappella', 'showchoir']);
  });

  it('every mode has a valid default segment and divisions', () => {
    for (const mode of MODES) {
      const segment = getSegment(mode, mode.defaultSegmentId);
      expect(segment.divisions.length).toBeGreaterThan(0);
      for (const d of segment.defaultDivisionIds) {
        expect(segment.divisions.some((div) => div.id === d)).toBe(true);
      }
      expect(mode.screens).toContain('scoreboard');
      expect(mode.terminology.ensemblePlural.length).toBeGreaterThan(0);
    }
  });

  it('division ids are unique within each segment', () => {
    for (const mode of MODES) {
      for (const segment of mode.segments) {
        const ids = segment.divisions.map((d) => d.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('WGI has exactly the three activities and calls the third Winds', () => {
    const wgi = getMode('wgi');
    expect(wgi.segments.map((s) => s.name)).toEqual(['Color Guard', 'Percussion', 'Winds']);
    expect(JSON.stringify(wgi.segments)).not.toMatch(/brass/i);
  });

  it('tournament modes do not pretend to have a season leaderboard', () => {
    const aca = getMode('acappella');
    for (const s of aca.segments) expect(s.rankingBehavior).toBe('tournament');
    const boa = getMode('boa');
    for (const s of boa.segments) expect(s.rankingBehavior).toBe('eventBased');
  });

  it('fixture-backed modes say so in their source note', () => {
    for (const mode of MODES) {
      if (mode.dataStatus === 'fixture') {
        expect(mode.dataSourceNote.toLowerCase()).toContain('fixture');
      }
    }
  });
});
