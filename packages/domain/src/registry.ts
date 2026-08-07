import type { ModeDefinition, ModeId, Segment } from './types';
import { dci } from './modes/dci';
import { wgi } from './modes/wgi';
import { boa } from './modes/boa';
import { acappella } from './modes/acappella';
import { showchoir } from './modes/showchoir';

export const MODES: ModeDefinition[] = [dci, wgi, boa, acappella, showchoir];

const byId = new Map<ModeId, ModeDefinition>(MODES.map((m) => [m.id, m]));

export function getMode(id: ModeId): ModeDefinition {
  const mode = byId.get(id);
  if (!mode) throw new Error(`Unknown mode: ${id}`);
  return mode;
}

export function isModeId(id: string): id is ModeId {
  return byId.has(id as ModeId);
}

export function getSegment(mode: ModeDefinition, segmentId: string): Segment {
  const segment = mode.segments.find((s) => s.id === segmentId);
  if (!segment) throw new Error(`Mode ${mode.id} has no segment ${segmentId}`);
  return segment;
}

export function getDivision(segment: Segment, divisionId: string) {
  const division = segment.divisions.find((d) => d.id === divisionId);
  if (!division) throw new Error(`Segment ${segment.id} has no division ${divisionId}`);
  return division;
}
