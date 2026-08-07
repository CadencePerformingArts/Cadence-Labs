import type {
  ChampionEntry,
  CompetitionEvent,
  Ensemble,
  ModeId,
  Provenance,
  Standings,
} from '@cadence/domain';

/**
 * The single seam between the app and its data. Today the app runs on
 * FixtureProvider (real DCI snapshot + labeled fixtures); when Supabase is
 * provisioned, a SupabaseProvider implements this same interface and the UI
 * does not change.
 */
export interface CadenceDataProvider {
  getStandings(modeId: ModeId, segmentId: string, divisionIds: string[]): Promise<Standings>;
  getEvents(modeId: ModeId, segmentId?: string): Promise<CompetitionEvent[]>;
  getEvent(modeId: ModeId, eventId: string): Promise<CompetitionEvent | undefined>;
  getEnsembles(modeId: ModeId, segmentId?: string): Promise<Ensemble[]>;
  getEnsemble(modeId: ModeId, ensembleId: string): Promise<Ensemble | undefined>;
  getChampions(modeId: ModeId): Promise<ChampionEntry[]>;
  getProvenance(modeId: ModeId, segmentId?: string): Promise<Provenance>;
}
