import React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDate } from '@cadence/domain';
import { Badge, Card, EmptyState, SectionHeader, spacing, useTheme } from '@cadence/ui';
import { provider } from '@cadence/data';
import { AppHeader } from '../../components/AppHeader';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useMode } from '../../state/ModeContext';

export default function Events() {
  const t = useTheme();
  const router = useRouter();
  const { mode, segment } = useMode();
  const { data, loading } = useAsyncData(
    () => provider.getEvents(mode.id, mode.segments.length > 1 ? segment.id : undefined),
    [mode.id, segment.id],
  );
  const upcoming = (data ?? []).filter((e) => e.upcoming).sort((a, b) => a.date.localeCompare(b.date));
  const past = (data ?? []).filter((e) => !e.upcoming);
  return (
    <View style={{ flex: 1, backgroundColor: t.page }}>
      <AppHeader subtitle={`${mode.terminology.eventPlural} · ${segment.name}`} />
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(8) }}>
        {loading && <ActivityIndicator style={{ marginTop: spacing(8) }} color={t.accent} />}
        {!loading && upcoming.length === 0 && past.length === 0 && (
          <EmptyState icon={mode.icon} message={mode.emptyState} />
        )}
        {upcoming.length > 0 && (
          <>
            <SectionHeader title="Upcoming" />
            {upcoming.map((event) => (
              <Card key={event.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Badge label={formatDate(event.date)} color={mode.accent} filled />
                  {event.city ? (
                    <Text style={{ color: t.muted, fontSize: 12 }}>{event.city}</Text>
                  ) : null}
                </View>
                <Text style={{ color: t.text, fontWeight: '800', fontSize: 16 }}>{event.name}</Text>
                {event.lineup && event.lineup.length > 0 && (
                  <Text style={{ color: t.textSecondary, fontSize: 12, marginTop: 4 }} numberOfLines={2}>
                    Lineup: {event.lineup.join(', ')}
                  </Text>
                )}
              </Card>
            ))}
          </>
        )}
        {past.length > 0 && (
          <>
            <SectionHeader title="Results" />
            {past.map((event) => {
              const finals = event.sessions[event.sessions.length - 1];
              const winner = finals?.results[0];
              return (
                <Card key={event.id}>
                  <Text
                    style={{ color: t.text, fontWeight: '800', fontSize: 15 }}
                    onPress={() => router.push(`/event/${mode.id}/${event.id}`)}
                  >
                    {event.name} →
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
                    {formatDate(event.date)}
                    {event.city ? ` · ${event.city}` : ''}
                    {event.sessions.length > 1 ? ` · ${event.sessions.map((s) => s.name).join(' + ')}` : ''}
                  </Text>
                  {winner && (
                    <Text style={{ color: t.textSecondary, fontSize: 13, marginTop: 4 }}>
                      🥇 {winner.ensembleName}
                      {winner.score !== undefined ? ` — ${winner.score}` : ''}
                      {winner.points !== undefined ? ` — ${winner.points} pts` : ''}
                    </Text>
                  )}
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}
