import type { ModeId } from '@cadence/domain';
import { getStorage } from './storage';

/**
 * Favorites are stored locally per mode and shaped so they can later sync to
 * a Supabase `favorites` table keyed by (user, mode, ensemble) without a
 * migration of meaning.
 */
const KEY = 'cadence.favorites.v1';

export type FavoritesMap = Partial<Record<ModeId, string[]>>;

export async function loadFavorites(): Promise<FavoritesMap> {
  try {
    const raw = await getStorage().getItem(KEY);
    return raw ? (JSON.parse(raw) as FavoritesMap) : {};
  } catch {
    return {};
  }
}

export async function toggleFavorite(modeId: ModeId, ensembleId: string): Promise<FavoritesMap> {
  const all = await loadFavorites();
  const current = all[modeId] ?? [];
  const next = current.includes(ensembleId)
    ? current.filter((id) => id !== ensembleId)
    : [...current, ensembleId];
  const updated = { ...all, [modeId]: next };
  await getStorage().setItem(KEY, JSON.stringify(updated));
  return updated;
}
