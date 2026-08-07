import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MODES, getMode } from '@cadence/domain';
import { Card, EmptyState, ScoreRow, SectionHeader, spacing, useTheme } from '@cadence/ui';
import { provider } from '@cadence/data';
import { AppHeader } from '../../components/AppHeader';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useMode } from '../../state/ModeContext';

interface FavRow {
  modeId: (typeof MODES)[number]['id'];
  ensembleId: string;
  name: string;
  sub?: string;
  score?: number;
}

export default function Favorites() {
  const t = useTheme();
  const router = useRouter();
  const { favorites, toggleFav } = useMode();
  const { data, loading } = useAsyncData(async () => {
    const sections: Array<{ modeName: string; icon: string; rows: FavRow[] }> = [];
    for (const mode of MODES) {
      const ids = favorites[mode.id] ?? [];
      if (ids.length === 0) continue;
      const rows: FavRow[] = [];
      for (const id of ids) {
        const ensemble = await provider.getEnsemble(mode.id, id);
        if (!ensemble) continue;
        const segment = mode.segments.find((s) => s.id === ensemble.segmentId) ?? mode.segments[0];
        let score: number | undefined;
        try {
          const standings = await provider.getStandings(mode.id, segment.id, [ensemble.divisionId]);
          score = standings.rows.find((r) => r.ensembleId === id)?.score;
        } catch {
          score = undefined;
        }
        rows.push({ modeId: mode.id, ensembleId: id, name: ensemble.name, sub: ensemble.location, score });
      }
      if (rows.length > 0) sections.push({ modeName: getMode(mode.id).name, icon: mode.icon, rows });
    }
    return sections;
  }, [JSON.stringify(favorites)]);

  const sections = data ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: t.page }}>
      <AppHeader subtitle="Favorites — all modes" />
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(8) }}>
        {!loading && sections.length === 0 && (
          <EmptyState
            icon="☆"
            message="Star an ensemble anywhere in Cadence and it shows up here — across every mode."
          />
        )}
        {sections.map((section) => (
          <View key={section.modeName}>
            <SectionHeader title={`${section.icon} ${section.modeName}`} />
            <Card>
              {section.rows.map((row) => (
                <ScoreRow
                  key={`${row.modeId}-${row.ensembleId}`}
                  name={row.name}
                  sub={row.sub}
                  score={row.score}
                  favorite
                  onToggleFavorite={() => toggleFav(row.modeId, row.ensembleId)}
                  onPress={() => router.push(`/ensemble/${row.modeId}/${row.ensembleId}`)}
                />
              ))}
            </Card>
          </View>
        ))}
        {sections.length > 0 && (
          <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center', padding: spacing(3) }}>
            Favorites are stored on this device today; signing in will sync them across devices
            once accounts launch.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
