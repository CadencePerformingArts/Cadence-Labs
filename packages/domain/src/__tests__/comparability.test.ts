import { describe, expect, it } from 'vitest';
import { canCompare, isComparableSelection, toggleDivision } from '../comparability';
import { getMode, getSegment } from '../registry';

const dciTour = getSegment(getMode('dci'), 'dci-tour');
const wgiGuard = getSegment(getMode('wgi'), 'guard');

describe('score comparability', () => {
  it('DCI World and Open may share a table', () => {
    expect(canCompare(dciTour, 'world', 'open')).toBe(true);
  });

  it('DCI All-Age and International never combine with World/Open', () => {
    expect(canCompare(dciTour, 'world', 'allage')).toBe(false);
    expect(canCompare(dciTour, 'open', 'intl')).toBe(false);
    expect(canCompare(dciTour, 'allage', 'intl')).toBe(false);
  });

  it('WGI classes are never comparable across class or scholastic/independent lines', () => {
    expect(canCompare(wgiGuard, 'cg-iw', 'cg-sw')).toBe(false);
    expect(canCompare(wgiGuard, 'cg-ia', 'cg-iw')).toBe(false);
    expect(canCompare(wgiGuard, 'cg-sa', 'cg-ia')).toBe(false);
  });

  it('validates whole selections', () => {
    expect(isComparableSelection(dciTour, ['world', 'open'])).toBe(true);
    expect(isComparableSelection(dciTour, ['world', 'open', 'allage'])).toBe(false);
    expect(isComparableSelection(dciTour, [])).toBe(true);
  });

  describe('toggleDivision', () => {
    it('adds a comparable division to the selection', () => {
      expect(toggleDivision(dciTour, ['world'], 'open')).toEqual(['world', 'open']);
    });

    it('resets to the tapped division when crossing comparability groups', () => {
      expect(toggleDivision(dciTour, ['world', 'open'], 'allage')).toEqual(['allage']);
    });

    it('removes on second tap but never empties the selection', () => {
      expect(toggleDivision(dciTour, ['world', 'open'], 'open')).toEqual(['world']);
      expect(toggleDivision(dciTour, ['world'], 'world')).toEqual(['world']);
    });
  });
});
