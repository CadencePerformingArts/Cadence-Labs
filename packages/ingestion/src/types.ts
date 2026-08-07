import type { ModeId, Provenance } from '@cadence/domain';

/**
 * A source adapter turns one external source's payloads into normalized
 * Cadence records. Adapters must be pure (fetching happens outside, so
 * contract tests can run on committed samples) and idempotent (same input →
 * same deterministic source keys).
 */
export interface AdapterResult<T> {
  ok: boolean;
  data?: T;
  /** Human-readable validation failures; non-empty implies ok === false. */
  errors: string[];
  /** Non-fatal oddities worth surfacing in ingestion logs. */
  warnings: string[];
}

export interface SourceAdapter<TRaw, TNormalized> {
  sourceId: string;
  modeId: ModeId;
  provenance(fetchedAt: string): Provenance;
  /** Parse and validate a raw payload. Never throws; reports via errors. */
  parse(raw: TRaw): AdapterResult<TNormalized>;
}
