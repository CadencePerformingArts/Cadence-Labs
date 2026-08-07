import { describe, expect, it } from 'vitest';
import { loadFavorites, toggleFavorite } from '../favorites';
import { loadPrefs, saveActiveMode, saveModePrefs } from '../prefs';

describe('local persistence', () => {
  it('toggles favorites per mode independently', async () => {
    await toggleFavorite('dci', 'bluecoats');
    await toggleFavorite('wgi', 'rhythm-x');
    let favs = await loadFavorites();
    expect(favs.dci).toEqual(['bluecoats']);
    expect(favs.wgi).toEqual(['rhythm-x']);
    await toggleFavorite('dci', 'bluecoats');
    favs = await loadFavorites();
    expect(favs.dci).toEqual([]);
    expect(favs.wgi).toEqual(['rhythm-x']);
  });

  it('remembers segment and filters separately per mode', async () => {
    await saveModePrefs('wgi', { segmentId: 'percussion', divisionIds: ['pc-iw'] });
    await saveModePrefs('dci', { divisionIds: ['world', 'open'] });
    await saveActiveMode('wgi');
    const prefs = await loadPrefs();
    expect(prefs.activeMode).toBe('wgi');
    expect(prefs.modes.wgi?.segmentId).toBe('percussion');
    expect(prefs.modes.dci?.divisionIds).toEqual(['world', 'open']);
  });
});
