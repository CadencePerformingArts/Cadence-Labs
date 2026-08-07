import {
  getMode,
  getSegment,
  isComparableSelection,
  type ChampionEntry,
  type CompetitionEvent,
  type Ensemble,
  type ModeId,
  type Provenance,
  type StandingRow,
  type Standings,
} from '@cadence/domain';
import type { CadenceDataProvider } from './provider';
import { standingsFromEvents } from './fixtures/helpers';
import dciSnapshot from './fixtures/dci-snapshot.json';
import { wgiEnsembles, wgiEvents, wgiProvenance } from './fixtures/wgi';
import { boaEnsembles, boaEvents, boaProvenance } from './fixtures/boa';
import { acaEnsembles, acaEvents, acaProvenance } from './fixtures/acappella';
import { scEnsembles, scEvents, scProvenance } from './fixtures/showchoir';

interface DciSnapshot {
  season: number;
  provenance: Provenance;
  standings: Record<string, StandingRow[]>;
  events: CompetitionEvent[];
  ensembles: Ensemble[];
  champions: ChampionEntry[];
}

const dci = dciSnapshot as unknown as DciSnapshot;

const EVENTS: Record<ModeId, CompetitionEvent[]> = {
  dci: dci.events,
  wgi: wgiEvents,
  boa: boaEvents,
  acappella: acaEvents,
  showchoir: scEvents,
};

const ENSEMBLES: Record<ModeId, Ensemble[]> = {
  dci: dci.ensembles,
  wgi: wgiEnsembles,
  boa: boaEnsembles,
  acappella: acaEnsembles,
  showchoir: scEnsembles,
};

const PROVENANCE: Record<ModeId, Provenance> = {
  dci: dci.provenance,
  wgi: wgiProvenance,
  boa: boaProvenance,
  acappella: acaProvenance,
  showchoir: scProvenance,
};

export class FixtureProvider implements CadenceDataProvider {
  async getStandings(
    modeId: ModeId,
    segmentId: string,
    divisionIds: string[],
  ): Promise<Standings> {
    const mode = getMode(modeId);
    const segment = getSegment(mode, segmentId);
    if (!isComparableSelection(segment, divisionIds)) {
      throw new Error(
        `Divisions [${divisionIds.join(', ')}] use incomparable score systems and cannot share a table`,
      );
    }
    let rows: StandingRow[];
    if (modeId === 'dci') {
      rows = divisionIds
        .flatMap((d) => dci.standings[d] ?? [])
        .sort((a, b) => b.score - a.score)
        .map((row, i) => ({ ...row, rank: i + 1 }));
    } else {
      const events = EVENTS[modeId].filter((e) => e.segmentId === segmentId);
      rows = standingsFromEvents(events, divisionIds);
    }
    return {
      modeId,
      segmentId,
      divisionIds,
      rows,
      provenance: PROVENANCE[modeId],
    };
  }

  async getEvents(modeId: ModeId, segmentId?: string): Promise<CompetitionEvent[]> {
    const events = EVENTS[modeId];
    const filtered = segmentId ? events.filter((e) => e.segmentId === segmentId) : events;
    return [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  }

  async getEvent(modeId: ModeId, eventId: string): Promise<CompetitionEvent | undefined> {
    return EVENTS[modeId].find((e) => e.id === eventId);
  }

  async getEnsembles(modeId: ModeId, segmentId?: string): Promise<Ensemble[]> {
    const list = ENSEMBLES[modeId];
    return segmentId ? list.filter((e) => e.segmentId === segmentId) : list;
  }

  async getEnsemble(modeId: ModeId, ensembleId: string): Promise<Ensemble | undefined> {
    return ENSEMBLES[modeId].find((e) => e.id === ensembleId);
  }

  async getChampions(modeId: ModeId): Promise<ChampionEntry[]> {
    return modeId === 'dci' ? dci.champions : [];
  }

  async getProvenance(modeId: ModeId): Promise<Provenance> {
    return PROVENANCE[modeId];
  }
}

export const provider: CadenceDataProvider = new FixtureProvider();
