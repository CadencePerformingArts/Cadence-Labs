import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { formatDate, formatScore, getMode, getSegment } from '@cadence/domain';
import { Card, Chip, ChipRow, EmptyState, ScoreRow, SectionHeader, spacing, useTheme } from '@cadence/ui';
import { provider } from '@cadence/data';
import { useAsyncData } from '../hooks/useAsyncData';
import { useMode } from '../state/ModeContext';

/** All-time record scores — currently DCI (real data back to 1972). */
export default function Records() {
  const t = useTheme();
  const { mode } = useMode();
  const segment = getSegment(getMode(mode.id), mode.defaultSegmentId);
  const { data } = useAsyncData(() => provider.getRecords(mode.id), [mode.id]);
  const divisions = [...new Set((data ?? []).map((r) => r.divisionId))];
  const [divisionId, setDivisionId] = useState<string | undefined>(undefined);
  const active = divisionId ?? divisions[0];
  const rows = (data ?? []).filter((r) => r.divisionId === active);

  if ((data ?? []).length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: t.page }}>
        <EmptyState icon="📜" message={`All-time records aren’t available for ${mode.name} yet.`} />
      </View>
    );
  }
  return (
    <ScrollView style={{ backgroundColor: t.page }} contentContainerStyle={{ paddingVertical: spacing(2), paddingBottom: spacing(8) }}>
      <ChipRow>
        {divisions.map((d) => {
          const div = segment.divisions.find((x) => x.id === d);
          return (
            <Chip
              key={d}
              label={div?.name ?? d}
              active={d === active}
              color={mode.accent}
              onPress={() => setDivisionId(d)}
            />
          );
        })}
      </ChipRow>
      <SectionHeader title="Highest scores of all time" />
      <Card>
        {rows.map((r, i) => (
          <ScoreRow
            key={`${r.name}-${r.date}`}
            rank={i + 1}
            name={`${r.name} · ${r.season}`}
            score={r.score}
            sub={`${r.event} · ${formatDate(r.date)}`}
          />
        ))}
      </Card>
      <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center', paddingHorizontal: spacing(6) }}>
        Records reflect scores as published; scoring systems have changed over the decades, so
        cross-era comparisons are approximate. Top score: {formatScore(rows[0]?.score)}.
      </Text>
    </ScrollView>
  );
}
