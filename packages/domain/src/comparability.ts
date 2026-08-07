import type { Segment } from './types';
import { getDivision } from './registry';

/**
 * Scores from two divisions may appear in one ranked table only when their
 * divisions share a comparability group — the single rule that prevents,
 * e.g., DCI All-Age scores being ranked against World Class, or WGI
 * Scholastic A against Independent World.
 */
export function canCompare(segment: Segment, divisionIdA: string, divisionIdB: string): boolean {
  if (divisionIdA === divisionIdB) return true;
  const a = getDivision(segment, divisionIdA);
  const b = getDivision(segment, divisionIdB);
  return a.comparabilityGroup === b.comparabilityGroup;
}

/** True when every division in the selection may share one ranked table. */
export function isComparableSelection(segment: Segment, divisionIds: string[]): boolean {
  if (divisionIds.length <= 1) return true;
  const [first, ...rest] = divisionIds;
  return rest.every((d) => canCompare(segment, first, d));
}

/**
 * Given a currently selected set and a division the user tapped, return the
 * next valid selection: toggles within the same comparability group, resets
 * to a single division when the tap crosses groups, and never returns an
 * empty selection.
 */
export function toggleDivision(
  segment: Segment,
  selected: string[],
  tapped: string,
): string[] {
  if (selected.includes(tapped)) {
    const next = selected.filter((d) => d !== tapped);
    return next.length > 0 ? next : [tapped];
  }
  if (isComparableSelection(segment, [...selected, tapped])) {
    return [...selected, tapped];
  }
  return [tapped];
}
