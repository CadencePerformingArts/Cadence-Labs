import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getMode,
  getSegment,
  toggleDivision,
  type ModeDefinition,
  type ModeId,
  type Segment,
} from '@cadence/domain';
import {
  loadFavorites,
  loadPrefs,
  saveActiveMode,
  saveModePrefs,
  setStorage,
  toggleFavorite,
  type FavoritesMap,
  type ModePrefsMap,
} from '@cadence/data';

setStorage(AsyncStorage);

interface ModeContextValue {
  hydrated: boolean;
  mode: ModeDefinition;
  segment: Segment;
  divisionIds: string[];
  favorites: FavoritesMap;
  setMode: (id: ModeId) => void;
  setSegment: (segmentId: string) => void;
  toggleDivisionFilter: (divisionId: string) => void;
  toggleFav: (modeId: ModeId, ensembleId: string) => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

function segmentFor(mode: ModeDefinition, prefs: ModePrefsMap): Segment {
  const wanted = prefs[mode.id]?.segmentId;
  const segment = mode.segments.find((s) => s.id === wanted);
  return segment ?? getSegment(mode, mode.defaultSegmentId);
}

function divisionsFor(mode: ModeDefinition, segment: Segment, prefs: ModePrefsMap): string[] {
  const saved = prefs[mode.id]?.segmentId === segment.id ? prefs[mode.id]?.divisionIds : undefined;
  const valid = saved?.filter((d) => segment.divisions.some((div) => div.id === d));
  return valid && valid.length > 0 ? valid : segment.defaultDivisionIds;
}

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [modeId, setModeId] = useState<ModeId>('dci');
  const [modePrefs, setModePrefs] = useState<ModePrefsMap>({});
  const [favorites, setFavorites] = useState<FavoritesMap>({});

  useEffect(() => {
    (async () => {
      const [prefs, favs] = await Promise.all([loadPrefs(), loadFavorites()]);
      if (prefs.activeMode) setModeId(prefs.activeMode);
      setModePrefs(prefs.modes);
      setFavorites(favs);
      setHydrated(true);
    })();
  }, []);

  const mode = getMode(modeId);
  const segment = segmentFor(mode, modePrefs);
  const divisionIds = divisionsFor(mode, segment, modePrefs);

  const setMode = useCallback((id: ModeId) => {
    setModeId(id);
    void saveActiveMode(id);
  }, []);

  const setSegment = useCallback(
    (segmentId: string) => {
      setModePrefs((prev) => ({ ...prev, [modeId]: { ...prev[modeId], segmentId } }));
      void saveModePrefs(modeId, { segmentId });
    },
    [modeId],
  );

  const toggleDivisionFilter = useCallback(
    (divisionId: string) => {
      const next = toggleDivision(segment, divisionIds, divisionId);
      setModePrefs((prev) => ({
        ...prev,
        [modeId]: { ...prev[modeId], segmentId: segment.id, divisionIds: next },
      }));
      void saveModePrefs(modeId, { segmentId: segment.id, divisionIds: next });
    },
    [modeId, segment, divisionIds],
  );

  const toggleFav = useCallback((favModeId: ModeId, ensembleId: string) => {
    void toggleFavorite(favModeId, ensembleId).then(setFavorites);
  }, []);

  const value = useMemo(
    () => ({
      hydrated,
      mode,
      segment,
      divisionIds,
      favorites,
      setMode,
      setSegment,
      toggleDivisionFilter,
      toggleFav,
    }),
    [hydrated, mode, segment, divisionIds, favorites, setMode, setSegment, toggleDivisionFilter, toggleFav],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used inside ModeProvider');
  return ctx;
}
