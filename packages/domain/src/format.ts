import type { ScoreSystem } from './types';

export function formatScore(value: number | null | undefined, system?: ScoreSystem): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (system?.unit === 'points') return `${Math.round(value)} pts`;
  const precision = system ? Math.min(system.precision, 3) : 3;
  // Trim trailing zeros but keep at least one decimal for score systems.
  const fixed = value.toFixed(precision);
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

export function formatDelta(delta: number | null | undefined): string {
  if (delta == null || Number.isNaN(delta)) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}
