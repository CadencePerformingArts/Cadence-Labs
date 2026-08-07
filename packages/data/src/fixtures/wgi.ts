/**
 * WGI fixture season — demonstration data only, never presented as live.
 * Ensembles are real, well-known units; scores, placements and events are
 * invented to exercise the WGI activity structure (Guard / Percussion /
 * Winds, class-separated tables, Prelims → Semis → Finals advancement).
 */
import type { CompetitionEvent, Ensemble } from '@cadence/domain';
import { ensemble, fixtureProvenance, results, slug } from './helpers';

export const wgiProvenance = fixtureProvenance('Cadence fixture data (WGI demo season)');

const guardIW = ['Pride of Cincinnati', 'Blessed Sacrament', 'Onyx', 'Paramount', 'Imbue', 'Bluecoats Indoor'];
const guardSW = ['Avon HS', 'Carmel HS', 'Tarpon Springs HS', 'Flanagan HS'];
const percIW = ['Rhythm X', 'Broken City', 'Pulse Percussion', 'Matrix', 'STRYKE Percussion', 'United Percussion'];
const percSW = ['Ayala HS', 'Chino Hills HS', 'Dartmouth HS'];
const windsIW = ['Rhythm X Winds', 'STRYKE Wynds', 'Cap City Winds', 'Resistance Winds'];
const windsSW = ['Flanagan HS Winds', 'Bellbrook HS Winds'];

export const wgiEnsembles: Ensemble[] = [
  ...guardIW.map((n) => ensemble('wgi', 'guard', 'cg-iw', n)),
  ...guardSW.map((n) => ensemble('wgi', 'guard', 'cg-sw', n)),
  ...percIW.map((n) => ensemble('wgi', 'percussion', 'pc-iw', n)),
  ...percSW.map((n) => ensemble('wgi', 'percussion', 'pc-sw', n)),
  ...windsIW.map((n) => ensemble('wgi', 'winds', 'wd-iw', n)),
  ...windsSW.map((n) => ensemble('wgi', 'winds', 'wd-sw', n)),
];

/** Deterministic spread so each regional shows plausible score growth. */
function scoresFor(names: string[], base: number, step: number, bump: number) {
  return names.map((name, i) => ({ name, score: +(base - i * step + bump).toFixed(3) }));
}

function regional(
  id: string,
  name: string,
  date: string,
  city: string,
  segmentId: 'guard' | 'percussion' | 'winds',
  iw: string[],
  sw: string[],
  bump: number,
): CompetitionEvent {
  const iwDiv = segmentId === 'guard' ? 'cg-iw' : segmentId === 'percussion' ? 'pc-iw' : 'wd-iw';
  const swDiv = segmentId === 'guard' ? 'cg-sw' : segmentId === 'percussion' ? 'pc-sw' : 'wd-sw';
  return {
    id,
    modeId: 'wgi',
    segmentId,
    name,
    date,
    city,
    sessions: [
      {
        id: `${id}-finals`,
        name: 'Finals',
        order: 1,
        results: results([
          ...scoresFor(iw, 88.5, 1.7, bump).map((r) => ({ ...r, divisionId: iwDiv })),
          ...scoresFor(sw, 86.2, 1.9, bump).map((r) => ({ ...r, divisionId: swDiv })),
        ]),
      },
    ],
  };
}

function championships(
  segmentId: 'guard' | 'percussion' | 'winds',
  iw: string[],
  sw: string[],
): CompetitionEvent {
  const iwDiv = segmentId === 'guard' ? 'cg-iw' : segmentId === 'percussion' ? 'pc-iw' : 'wd-iw';
  const swDiv = segmentId === 'guard' ? 'cg-sw' : segmentId === 'percussion' ? 'pc-sw' : 'wd-sw';
  const id = `wgi-2026-worlds-${segmentId}`;
  const finalists = iw.slice(0, Math.max(3, iw.length - 1));
  return {
    id,
    modeId: 'wgi',
    segmentId,
    name: `WGI World Championships — ${segmentId === 'guard' ? 'Color Guard' : segmentId === 'percussion' ? 'Percussion' : 'Winds'}`,
    date: '2026-04-18',
    city: 'Dayton, OH',
    venue: 'UD Arena',
    sessions: [
      {
        id: `${id}-prelims`,
        name: 'Prelims',
        order: 1,
        results: results([
          ...scoresFor(iw, 92.0, 1.4, 0).map((r, i) => ({ ...r, divisionId: iwDiv, advanced: i < finalists.length })),
          ...scoresFor(sw, 90.1, 1.6, 0).map((r, i) => ({ ...r, divisionId: swDiv, advanced: i < 3 })),
        ]),
      },
      {
        id: `${id}-semis`,
        name: 'Semifinals',
        order: 2,
        results: results([
          ...scoresFor(finalists, 93.2, 1.3, 0).map((r) => ({ ...r, divisionId: iwDiv, advanced: true })),
        ]),
      },
      {
        id: `${id}-finals`,
        name: 'Finals',
        order: 3,
        results: results([
          ...scoresFor(finalists, 95.3, 1.2, 0).map((r, i) => ({
            ...r,
            divisionId: iwDiv,
            awards: i === 0 ? [`${segmentId === 'guard' ? 'Color Guard' : segmentId === 'percussion' ? 'Percussion' : 'Winds'} Independent World Champion`] : undefined,
          })),
          ...scoresFor(sw.slice(0, 3), 94.0, 1.5, 0).map((r, i) => ({
            ...r,
            divisionId: swDiv,
            awards: i === 0 ? ['Scholastic World Champion'] : undefined,
          })),
        ]),
      },
    ],
  };
}

export const wgiEvents: CompetitionEvent[] = [
  regional('wgi-2026-mideast-guard', 'WGI Mid-East Power Regional', '2026-02-21', 'Cincinnati, OH', 'guard', guardIW, guardSW, 0),
  regional('wgi-2026-dayton-guard', 'WGI Dayton Regional', '2026-03-14', 'Dayton, OH', 'guard', guardIW, guardSW, 1.9),
  regional('wgi-2026-socal-perc', 'WGI SoCal Power Regional', '2026-02-28', 'Riverside, CA', 'percussion', percIW, percSW, 0),
  regional('wgi-2026-indy-perc', 'WGI Indianapolis Regional', '2026-03-21', 'Indianapolis, IN', 'percussion', percIW, percSW, 2.1),
  regional('wgi-2026-tampa-winds', 'WGI Tampa Regional', '2026-03-07', 'Tampa, FL', 'winds', windsIW, windsSW, 0),
  championships('guard', guardIW, guardSW),
  championships('percussion', percIW, percSW),
  championships('winds', windsIW, windsSW),
  {
    id: 'wgi-2027-mideast-upcoming',
    modeId: 'wgi',
    segmentId: 'guard',
    name: 'WGI Mid-East Power Regional (2027 season)',
    date: '2027-02-20',
    city: 'Cincinnati, OH',
    sessions: [],
    upcoming: true,
    lineup: guardIW.slice(0, 4),
  },
];

export const wgiSlug = slug;
