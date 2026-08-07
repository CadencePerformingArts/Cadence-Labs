import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatDate,
  formatScore,
  getDivision,
  getMode,
  getSegment,
  isModeId,
  ordinal,
  type TrendPoint,
} from '@cadence/domain';
import {
  Badge,
  Card,
  EmptyState,
  SectionHeader,
  TrendChart,
  spacing,
  useTheme,
} from '@cadence/ui';
import { provider } from '@cadence/data';
import { useAsyncData } from '../../../hooks/useAsyncData';
import { useMode } from '../../../state/ModeContext';

/** Mode-aware deep link: /ensemble/dci/bluecoats */
export default function EnsembleProfile() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ mode: string; id: string }>();
  const modeId = isModeId(params.mode ?? '') ? (params.mode as ReturnType<typeof getMode>['id']) : 'dci';
  const mode = getMode(modeId);
  const { favorites, toggleFav } = useMode();

  const { data, loading } = useAsyncData(async () => {
    const ensemble = await provider.getEnsemble(modeId, params.id ?? '');
    if (!ensemble) return undefined;
    const segment = getSegment(mode, ensemble.segmentId);
    let standingRow;
    try {
      const standings = await provider.getStandings(modeId, segment.id, [ensemble.divisionId]);
      standingRow = standings.rows.find((r) => r.ensembleId === ensemble.id);
    } catch {
      standingRow = undefined;
    }
    const events = await provider.getEvents(modeId);
    const appearances = events
      .filter((e) => !e.upcoming)
      .flatMap((event) =>
        event.sessions.flatMap((session) =>
          session.results
            .filter((r) => r.ensembleId === ensemble.id)
            .map((r) => ({ event, session, result: r })),
        ),
      )
      .sort((a, b) => b.event.date.localeCompare(a.event.date));
    const champions = (await provider.getChampions(modeId)).filter((c) => c.name === ensemble.name);
    const trend: TrendPoint[] =
      standingRow?.trend ??
      appearances
        .map((a) => ({ date: a.event.date, score: a.result.score ?? a.result.points ?? 0 }))
        .filter((p) => p.score > 0)
        .reverse();
    return { ensemble, segment, standingRow, appearances, champions, trend };
  }, [modeId, params.id]);

  if (loading) return <ActivityIndicator style={{ marginTop: spacing(10) }} color={t.accent} />;
  if (!data) return <EmptyState icon="🔎" message="Profile not found." />;

  const { ensemble, segment, standingRow, appearances, champions, trend } = data;
  const division = getDivision(segment, ensemble.divisionId);
  const isFav = (favorites[modeId] ?? []).includes(ensemble.id);
  const chartWidth = Math.min(width, 720) - spacing(3) * 2 - spacing(3) * 2;

  return (
    <ScrollView style={{ backgroundColor: t.page }} contentContainerStyle={{ paddingVertical: spacing(3), paddingBottom: spacing(8) }}>
      <Stack.Screen options={{ title: ensemble.name }} />
      <View
        style={{
          paddingHorizontal: spacing(4),
          marginBottom: spacing(2),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: t.text, fontWeight: '900', fontSize: 22 }}>{ensemble.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge label={division.name} color={mode.accent} filled />
            {ensemble.location ? (
              <Text style={{ color: t.muted, fontSize: 13 }}>{ensemble.location}</Text>
            ) : null}
          </View>
        </View>
        <Pressable onPress={() => toggleFav(modeId, ensemble.id)} hitSlop={12}>
          <Text style={{ fontSize: 28, opacity: isFav ? 1 : 0.5 }}>{isFav ? '★' : '☆'}</Text>
        </Pressable>
      </View>

      {standingRow && (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700' }}>RANK</Text>
              <Text style={{ color: t.accent, fontSize: 26, fontWeight: '900' }}>
                {ordinal(standingRow.rank)}
              </Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700' }}>LATEST</Text>
              <Text style={{ color: t.text, fontSize: 26, fontWeight: '900' }}>
                {formatScore(standingRow.score)}
              </Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700' }}>OUTINGS</Text>
              <Text style={{ color: t.text, fontSize: 26, fontWeight: '900' }}>
                {standingRow.outings ?? appearances.length}
              </Text>
            </View>
          </View>
        </Card>
      )}

      {trend.length > 1 && (
        <>
          <SectionHeader title="Season progression" />
          <Card>
            <TrendChart points={trend} width={chartWidth} color={mode.accent} />
          </Card>
        </>
      )}

      {champions.length > 0 && (
        <>
          <SectionHeader title="Championship titles" />
          <Card>
            {champions.map((c) => (
              <Text key={c.season} style={{ color: t.text, fontSize: 14, paddingVertical: 3 }}>
                🏆 {c.season} — {formatScore(c.score)}
              </Text>
            ))}
          </Card>
        </>
      )}

      {appearances.length > 0 && (
        <>
          <SectionHeader title="Results" />
          <Card>
            {appearances.map(({ event, session, result }) => (
              <Pressable
                key={`${event.id}-${session.id}`}
                onPress={() => router.push(`/event/${modeId}/${event.id}`)}
                style={({ pressed }) => ({
                  paddingVertical: spacing(2),
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing(2) }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
                      {event.name}
                    </Text>
                    <Text style={{ color: t.muted, fontSize: 11 }}>
                      {formatDate(event.date)} · {session.name}
                      {result.rank ? ` · ${ordinal(result.rank)}` : ''}
                    </Text>
                  </View>
                  <Text style={{ color: t.text, fontWeight: '800', fontSize: 16 }}>
                    {result.points !== undefined ? `${result.points} pts` : formatScore(result.score)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
