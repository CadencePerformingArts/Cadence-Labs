import type { ModeId } from '@cadence/domain';
import { getStorage } from './storage';

/**
 * Per-mode UI memory: the last segment and division filters a user chose in
 * each mode are remembered independently, so switching DCI → WGI → DCI
 * restores exactly where they left off.
 */
const KEY = 'cadence.modeprefs.v1';

export interface ModePrefs {
  segmentId?: string;
  divisionIds?: string[];
}

export type ModePrefsMap = Partial<Record<ModeId, ModePrefs>>;

export interface GlobalPrefs {
  activeMode?: ModeId;
  modes: ModePrefsMap;
}

export async function loadPrefs(): Promise<GlobalPrefs> {
  try {
    const raw = await getStorage().getItem(KEY);
    return raw ? (JSON.parse(raw) as GlobalPrefs) : { modes: {} };
  } catch {
    return { modes: {} };
  }
}

export async function savePrefs(prefs: GlobalPrefs): Promise<void> {
  await getStorage().setItem(KEY, JSON.stringify(prefs));
}

export async function saveModePrefs(modeId: ModeId, patch: ModePrefs): Promise<GlobalPrefs> {
  const prefs = await loadPrefs();
  const next: GlobalPrefs = {
    ...prefs,
    modes: { ...prefs.modes, [modeId]: { ...prefs.modes[modeId], ...patch } },
  };
  await savePrefs(next);
  return next;
}

export async function saveActiveMode(modeId: ModeId): Promise<GlobalPrefs> {
  const prefs = await loadPrefs();
  const next = { ...prefs, activeMode: modeId };
  await savePrefs(next);
  return next;
}
