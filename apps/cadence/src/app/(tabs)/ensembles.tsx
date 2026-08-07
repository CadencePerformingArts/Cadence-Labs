import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getDivision } from '@cadence/domain';
import { Card, EmptyState, ScoreRow, SectionHeader, radius, spacing, useTheme } from '@cadence/ui';
import { provider } from '@cadence/data';
import { AppHeader } from '../../components/AppHeader';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useMode } from '../../state/ModeContext';

export default function Ensembles() {
  const t = useTheme();
  const router = useRouter();
  const { mode, segment, favorites, toggleFav } = useMode();
  const [query, setQuery] = useState('');
  const { data, loading } = useAsyncData(
    () => provider.getEnsembles(mode.id, mode.segments.length > 1 ? segment.id : undefined),
    [mode.id, segment.id],
  );
  const favs = favorites[mode.id] ?? [];
  const groups = useMemo(() => {
    const filtered = (data ?? []).filter((e) =>
      e.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const byDivision = new Map<string, typeof filtered>();
    for (const e of filtered) {
      byDivision.set(e.divisionId, [...(byDivision.get(e.divisionId) ?? []), e]);
    }
    return [...byDivision.entries()];
  }, [data, query]);
  return (
    <View style={{ flex: 1, backgroundColor: t.page }}>
      <AppHeader subtitle={`${mode.terminology.ensemblePlural} · ${segment.name}`} />
      <View style={{ padding: spacing(3) }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${mode.terminology.ensemblePlural.toLowerCase()}…`}
          placeholderTextColor={t.muted}
          style={{
            backgroundColor: t.surface,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: t.border,
            color: t.text,
            paddingHorizontal: spacing(3),
            paddingVertical: spacing(2.5),
            fontSize: 15,
          }}
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(8) }}>
        {loading && <ActivityIndicator style={{ marginTop: spacing(8) }} color={t.accent} />}
        {!loading && groups.length === 0 && <EmptyState icon={mode.icon} message="No matches." />}
        {groups.map(([divisionId, list]) => {
          let divisionName = divisionId;
          try {
            divisionName = getDivision(segment, divisionId).name;
          } catch {
            // Ensembles outside the active segment keep their raw division id.
          }
          return (
            <View key={divisionId}>
              <SectionHeader title={divisionName} />
              <Card>
                {list.map((e) => (
                  <ScoreRow
                    key={e.id}
                    name={e.name}
                    sub={e.location}
                    favorite={favs.includes(e.id)}
                    onToggleFavorite={() => toggleFav(mode.id, e.id)}
                    onPress={() => router.push(`/ensemble/${mode.id}/${e.id}`)}
                  />
                ))}
              </Card>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
