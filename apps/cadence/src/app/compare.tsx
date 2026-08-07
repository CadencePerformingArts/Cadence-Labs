import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { formatScore } from '@cadence/domain';
import {
  Card,
  EmptyState,
  MultiTrendChart,
  SectionHeader,
  brand,
  spacing,
  type,
  useTheme,
} from '@cadence/ui';
import { provider } from '@cadence/data';
import { useAsyncData } from '../hooks/useAsyncData';
import { useMode } from '../state/ModeContext';

const SERIES_COLORS = [brand.gold, '#7c3aed', '#0891b2', '#dc2626'];
const MAX_SELECTED = 4;

/** Head-to-head comparison: overlay season trends for up to four ensembles. */
export default function Compare() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const { mode, segment, divisionIds } = useMode();
  const [selected, setSelected] = useState<string[]>([]);
  const { data } = useAsyncData(
    () => provider.getStandings(mode.id, segment.id, divisionIds),
    [mode.id, segment.id, divisionIds.join(',')],
  );
  const rows = (data?.rows ?? []).filter((r) => (r.trend?.length ?? 0) > 1);

  if (rows.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: t.page }}>
        <EmptyState icon="⚖️" message="Not enough season data to compare here yet." />
      </View>
    );
  }

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= MAX_SELECTED
          ? prev
          : [...prev, id],
    );

  const series = selected
    .map((id, i) => {
      const row = rows.find((r) => r.ensembleId === id);
      return row
        ? { name: row.name, color: SERIES_COLORS[i % SERIES_COLORS.length], points: row.trend ?? [] }
        : undefined;
    })
    .filter((s): s is NonNullable<typeof s> => !!s);

  const chartWidth = Math.min(width, 720) - spacing(3) * 2 - spacing(3) * 2;

  return (
    <ScrollView style={{ backgroundColor: t.page }} contentContainerStyle={{ paddingVertical: spacing(2), paddingBottom: spacing(8) }}>
      {series.length > 0 ? (
        <>
          <SectionHeader title="Season trends, head to head" />
          <Card>
            <MultiTrendChart series={series} width={chartWidth} />
          </Card>
        </>
      ) : (
        <Text style={{ color: t.muted, fontSize: type.small, textAlign: 'center', padding: spacing(4) }}>
          Pick up to {MAX_SELECTED} {mode.terminology.ensemblePlural.toLowerCase()} below to
          overlay their season progressions.
        </Text>
      )}
      <SectionHeader title={mode.terminology.ensemblePlural} />
      <Card>
        {rows.map((row) => {
          const idx = selected.indexOf(row.ensembleId);
          const isSel = idx >= 0;
          return (
            <Pressable
              key={row.ensembleId}
              onPress={() => toggle(row.ensembleId)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing(2.5),
                paddingVertical: spacing(2),
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: isSel ? SERIES_COLORS[idx % SERIES_COLORS.length] : t.border,
                  backgroundColor: isSel ? SERIES_COLORS[idx % SERIES_COLORS.length] : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isSel && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>✓</Text>}
              </View>
              <Text style={{ flex: 1, color: t.text, fontWeight: '700', fontSize: type.body }}>
                {row.name}
              </Text>
              <Text style={{ color: t.textSecondary, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
                {formatScore(row.score)}
              </Text>
            </Pressable>
          );
        })}
      </Card>
    </ScrollView>
  );
}
