import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatDate,
  getDivision,
  getMode,
  getSegment,
  isModeId,
} from '@cadence/domain';
import {
  Card,
  Chip,
  ChipRow,
  EmptyState,
  FreshnessBadge,
  ScoreRow,
  spacing,
  useTheme,
} from '@cadence/ui';
import { provider } from '@cadence/data';
import { useAsyncData } from '../../../hooks/useAsyncData';

/** Mode-aware deep link: /event/dci/2026-dci-world-championship-finals-… */
export default function EventDetail() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode: string; id: string }>();
  const modeId = isModeId(params.mode ?? '') ? (params.mode as ReturnType<typeof getMode>['id']) : 'dci';
  const mode = getMode(modeId);
  const [sessionIndex, setSessionIndex] = useState<number | undefined>(undefined);
  const { data: event, loading } = useAsyncData(
    () => provider.getEvent(modeId, params.id ?? ''),
    [modeId, params.id],
  );
  const { data: provenance } = useAsyncData(() => provider.getProvenance(modeId), [modeId]);

  if (loading) {
    return <ActivityIndicator style={{ marginTop: spacing(10) }} color={t.accent} />;
  }
  if (!event) {
    return <EmptyState icon="🔎" message="Event not found." />;
  }
  const segment = getSegment(mode, event.segmentId);
  const activeIndex = sessionIndex ?? Math.max(event.sessions.length - 1, 0);
  const session = event.sessions[activeIndex];
  return (
    <ScrollView style={{ backgroundColor: t.page }} contentContainerStyle={{ paddingVertical: spacing(3), paddingBottom: spacing(8) }}>
      <Stack.Screen options={{ title: event.name }} />
      <View style={{ paddingHorizontal: spacing(4), marginBottom: spacing(2) }}>
        <Text style={{ color: t.text, fontWeight: '900', fontSize: 20 }}>{event.name}</Text>
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
          {formatDate(event.date)}
          {event.city ? ` · ${event.city}` : ''}
          {event.venue ? ` · ${event.venue}` : ''}
          {event.region ? ` · ${event.region} region` : ''}
        </Text>
      </View>
      {event.upcoming ? (
        <Card>
          <Text style={{ color: t.text, fontWeight: '700', marginBottom: 4 }}>Scheduled</Text>
          {event.lineup && event.lineup.length > 0 ? (
            <Text style={{ color: t.textSecondary, fontSize: 14, lineHeight: 21 }}>
              Lineup: {event.lineup.join(', ')}
            </Text>
          ) : (
            <Text style={{ color: t.muted }}>Lineup not yet announced.</Text>
          )}
        </Card>
      ) : (
        <>
          {event.sessions.length > 1 && (
            <ChipRow>
              {event.sessions.map((s, i) => (
                <Chip
                  key={s.id}
                  label={s.name}
                  active={i === activeIndex}
                  color={mode.accent}
                  onPress={() => setSessionIndex(i)}
                />
              ))}
            </ChipRow>
          )}
          {session && (
            <Card>
              {session.results.map((r) => {
                let division;
                try {
                  division = getDivision(segment, r.divisionId);
                } catch {
                  division = undefined;
                }
                return (
                  <ScoreRow
                    key={`${r.ensembleId}-${r.rank}`}
                    rank={r.rank}
                    name={r.ensembleName}
                    division={division}
                    score={r.score}
                    points={r.points}
                    advanced={r.advanced}
                    awards={r.awards}
                    captions={r.captions}
                    penalty={r.penalty}
                    onPress={() => router.push(`/ensemble/${modeId}/${r.ensembleId}`)}
                  />
                );
              })}
            </Card>
          )}
        </>
      )}
      {provenance && (
        <View style={{ alignItems: 'center', marginTop: spacing(2) }}>
          <FreshnessBadge provenance={provenance} />
        </View>
      )}
    </ScrollView>
  );
}
