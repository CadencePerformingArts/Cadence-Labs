/**
 * Core domain types for Cadence — the year-round scoreboard for competitive
 * musical and performing arts.
 *
 * A Mode is one activity vertical (DCI, WGI, BOA, A Cappella, Show Choir).
 * A Segment is a sub-competition within a mode that has its own circuit,
 * divisions and scoring (WGI's Color Guard / Percussion / Winds activities,
 * A Cappella's ICCA / ICHSA / The Open). Modes with a single circuit have a
 * single default segment.
 */

export type ModeId = 'dci' | 'wgi' | 'boa' | 'acappella' | 'showchoir';

/** How results in a segment are meaningfully presented. */
export type RankingBehavior =
  /** Season-long leaderboard of latest/best scores (DCI, WGI). */
  | 'seasonLeaderboard'
  /** Results only exist per event; no cross-event league table (BOA, Show Choir). */
  | 'eventBased'
  /** Bracket/advancement tournament across rounds and regions (ICCA/ICHSA). */
  | 'tournament';

export type DataStatus =
  /** Continuously ingested from a permitted source. */
  | 'live'
  /** A real dataset captured at a point in time (clearly stamped). */
  | 'snapshot'
  /** Hand-built demonstration data. Must never be presented as real. */
  | 'fixture';

export interface ScoreSystem {
  id: string;
  name: string;
  /** Maximum attainable score, e.g. 100 for DCI. */
  max: number;
  /** Decimal places scores are published with. */
  precision: number;
  /** Points-based systems (ICCA) rank by total points instead. */
  unit: 'score' | 'points';
}

export interface Division {
  id: string;
  name: string;
  /** Compact identifier for combined tables, e.g. "WORLD", "OPEN". */
  short: string;
  scoreSystemId: string;
  /**
   * Divisions sharing a comparability group id may be ranked in one table.
   * Divisions in different groups must never be merged, even in the same
   * segment (e.g. DCI All-Age vs World Class).
   */
  comparabilityGroup: string;
}

export interface Segment {
  id: string;
  name: string;
  shortName?: string;
  divisions: Division[];
  scoreSystems: ScoreSystem[];
  /** Divisions selected by default when the segment opens. */
  defaultDivisionIds: string[];
  rankingBehavior: RankingBehavior;
  /** Ordered round names where rounds exist (Prelims → Finals). */
  rounds?: string[];
  /** True when winners advance through rounds/regions (BOA, ICCA). */
  advancement?: boolean;
}

export interface Terminology {
  /** What a competing unit is called: Corps, Band, Ensemble, Group, Choir. */
  ensemble: string;
  ensemblePlural: string;
  /** What a competition is called: Show, Regional, Competition, Event. */
  event: string;
  eventPlural: string;
  /** Label for the main results surface: Scoreboard, Standings, Results. */
  scoreboard: string;
}

export type ScreenId =
  | 'scoreboard'
  | 'events'
  | 'ensembles'
  | 'favorites'
  | 'more';

export interface ModeFeatures {
  captions: boolean;
  historical: boolean;
  predictions: boolean;
  brackets: boolean;
}

export interface ModeDefinition {
  id: ModeId;
  name: string;
  shortName: string;
  /** Emoji used as the mode's contextual icon. */
  icon: string;
  /** Restrained secondary accent layered over the Cadence navy/gold shell. */
  accent: string;
  tagline: string;
  terminology: Terminology;
  segments: Segment[];
  defaultSegmentId: string;
  screens: ScreenId[];
  features: ModeFeatures;
  dataStatus: DataStatus;
  /** Shown wherever data freshness/source matters. */
  dataSourceNote: string;
  emptyState: string;
}

/* ------------------------------------------------------------------ */
/* Result data                                                         */
/* ------------------------------------------------------------------ */

export interface Provenance {
  sourceId: string;
  sourceName: string;
  url?: string;
  /** ISO timestamp of when the data was captured. */
  fetchedAt: string;
  kind: DataStatus;
}

export interface Ensemble {
  id: string;
  modeId: ModeId;
  segmentId: string;
  divisionId: string;
  name: string;
  location?: string;
  aliases?: string[];
}

export interface CaptionScore {
  caption: string;
  score: number;
}

export interface Performance {
  ensembleId: string;
  ensembleName: string;
  divisionId: string;
  /** Absent when the round published placement only. */
  score?: number;
  points?: number;
  rank?: number;
  captions?: CaptionScore[];
  awards?: string[];
  penalty?: number;
  advanced?: boolean;
}

export interface Session {
  id: string;
  /** Round name: "Prelims", "Finals", "Quarterfinal", or "Results". */
  name: string;
  order: number;
  results: Performance[];
}

export interface CompetitionEvent {
  id: string;
  modeId: ModeId;
  segmentId: string;
  name: string;
  /** ISO date in the event's local timezone. */
  date: string;
  timezone?: string;
  city?: string;
  venue?: string;
  /** Region for tournament modes (ICCA "Northeast"). */
  region?: string;
  sessions: Session[];
  /** True when the event is scheduled but has no results yet. */
  upcoming?: boolean;
  lineup?: string[];
}

export interface TrendPoint {
  date: string;
  score: number;
}

export interface StandingRow {
  ensembleId: string;
  name: string;
  divisionId: string;
  rank: number;
  score: number;
  /** Change vs previous outing. */
  delta?: number;
  lastEvent?: string;
  lastDate?: string;
  outings?: number;
  trend?: TrendPoint[];
}

export interface Standings {
  modeId: ModeId;
  segmentId: string;
  divisionIds: string[];
  rows: StandingRow[];
  provenance: Provenance;
}

export interface ChampionEntry {
  season: string;
  divisionId: string;
  name: string;
  score?: number;
}

/** An all-time record score (e.g. highest World Class finals scores ever). */
export interface ScoreRecord {
  season: string;
  date: string;
  divisionId: string;
  name: string;
  score: number;
  event: string;
}
