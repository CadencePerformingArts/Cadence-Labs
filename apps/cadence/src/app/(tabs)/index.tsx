import React, { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDate, getDivision, type StandingRow } from '@cadence/domain';
import {
  Card,
  Chip,
  ChipRow,
  EmptyState,
  FreshnessBadge,
  ScoreRow,
  SectionHeader,
  StatCard,
  spacing,
  useTheme,
} from '@cadence/ui';
import { provider } from '@cadence/data';
import { AppHeader } from '../../components/AppHeader';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useMode } from '../../state/ModeContext';

/** Biggest single-outing gain among the current rows. */
function biggestMove(rows: StandingRow[]): StandingRow | undefined {
  const movers = rows.filter((r) => (r.delta ?? 0) > 0);
  return movers.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
}

/** Smallest score gap between adjacent ranks. */
function closestBattle(rows: StandingRow[]): [StandingRow, StandingRow] | undefined {
  let best: [StandingRow, StandingRow] | undefined;
  let gap = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i - 1].score - rows[i].score;
    if (d < gap) {
      gap = d;
      best = [rows[i - 1], rows[i]];
    }
  }
  return best;
}

function LeaderboardView() {
  const t = useTheme();
  const router = useRouter();
  const { mode, segment, divisionIds, favorites, toggleDivisionFilter, toggleFav } = useMode();
  const { data, loading, error } = useAsyncData(
    () => provider.getStandings(mode.id, segment.id, divisionIds),
    [mode.id, segment.id, divisionIds.join(',')],
  );

  const move = useMemo(() => (data ? biggestMove(data.rows) : undefined), [data]);
  const battle = useMemo(() => (data ? closestBattle(data.rows) : undefined), [data]);
  const favs = favorites[mode.id] ?? [];

  return (
    <>
      <ChipRow>
        {segment.divisions.map((d) => (
          <Chip
            key={d.id}
            label={d.name}
            active={divisionIds.includes(d.id)}
            color={mode.accent}
            onPress={() => toggleDivisionFilter(d.id)}
          />
        ))}
      </ChipRow>
      {loading && <ActivityIndicator style={{ marginTop: spacing(8) }} color={t.accent} />}
      {error && <EmptyState icon="⚠️" message={error} />}
      {data && data.rows.length === 0 && <EmptyState icon={mode.icon} message={mode.emptyState} />}
      {data && data.rows.length > 0 && (
        <>
          {(move || battle) && (
            <View style={{ flexDirection: 'row', gap: spacing(2.5), paddingHorizontal: spacing(3), marginBottom: spacing(2.5) }}>
              {move && (
                <StatCard
                  icon="📈"
                  label="Biggest Move"
                  headline={move.name}
                  detail={`+${(move.delta ?? 0).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} to ${move.score} at ${move.lastEvent ?? 'last outing'}`}
                />
              )}
              {battle && (
                <StatCard
                  icon="⚔️"
                  label="Closest Battle"
                  headline={`${battle[0].name} vs ${battle[1].name}`}
                  detail={`${(battle[0].score - battle[1].score).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} apart at #${battle[0].rank}–${battle[1].rank}`}
                />
              )}
            </View>
          )}
          <Card>
            {data.rows.map((row) => (
              <ScoreRow
                key={row.ensembleId}
                rank={row.rank}
                name={row.name}
                division={divisionIds.length > 1 ? getDivision(segment, row.divisionId) : undefined}
                score={row.score}
                delta={row.delta}
                sub={row.lastEvent ? `${row.lastEvent} · ${formatDate(row.lastDate ?? '')}` : undefined}
                trend={row.trend?.map((p) => p.score)}
                favorite={favs.includes(row.ensembleId)}
                onToggleFavorite={() => toggleFav(mode.id, row.ensembleId)}
                onPress={() => router.push(`/ensemble/${mode.id}/${row.ensembleId}`)}
              />
            ))}
          </Card>
          <View style={{ alignItems: 'center', paddingBottom: spacing(6) }}>
            <FreshnessBadge provenance={data.provenance} />
          </View>
        </>
      )}
    </>
  );
}

function EventResultsView() {
  const t = useTheme();
  const router = useRouter();
  const { mode, segment } = useMode();
  const { data, loading } = useAsyncData(
    () => provider.getEvents(mode.id, segment.id),
    [mode.id, segment.id],
  );
  const scored = (data ?? []).filter((e) => !e.upcoming);
  return (
    <>
      <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: spacing(4), paddingVertical: spacing(2) }}>
        {mode.shortName} results are per event — each championship has its own judging panel, so
        Cadence doesn’t combine them into a national table.
      </Text>
      {loading && <ActivityIndicator style={{ marginTop: spacing(8) }} color={t.accent} />}
      {!loading && scored.length === 0 && <EmptyState icon={mode.icon} message={mode.emptyState} />}
      {scored.map((event) => {
        const finals = event.sessions[event.sessions.length - 1];
        const podium = finals?.results.slice(0, 3) ?? [];
        return (
          <Card key={event.id}>
            <SectionHeader title={`${formatDate(event.date)} · ${event.city ?? ''}`} />
            <Text
              style={{ color: t.text, fontWeight: '800', fontSize: 16, paddingHorizontal: spacing(1), marginBottom: spacing(1) }}
              onPress={() => router.push(`/event/${mode.id}/${event.id}`)}
            >
              {event.name} →
            </Text>
            {podium.map((r) => (
              <ScoreRow
                key={r.ensembleId}
                rank={r.rank}
                name={r.ensembleName}
                division={getDivision(segment, r.divisionId)}
                score={r.score}
                points={r.points}
                awards={r.awards}
                onPress={() => router.push(`/event/${mode.id}/${event.id}`)}
              />
            ))}
          </Card>
        );
      })}
    </>
  );
}

function TournamentView() {
  const t = useTheme();
  const router = useRouter();
  const { mode, segment } = useMode();
  const { data, loading } = useAsyncData(
    () => provider.getEvents(mode.id, segment.id),
    [mode.id, segment.id],
  );
  const rounds = segment.rounds ?? [];
  const scored = (data ?? []).filter((e) => !e.upcoming);
  const byRound = rounds.map((round) => ({
    round,
    events: scored
      .filter((e) => e.name.toLowerCase().includes(round.toLowerCase().replace('final', 'final')))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));
  return (
    <>
      <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: spacing(4), paddingVertical: spacing(2) }}>
        {segment.name} is a bracket: groups advance from regional quarterfinals through semifinals
        to the Finals stage. Points rank groups within one round only.
      </Text>
      {loading && <ActivityIndicator style={{ marginTop: spacing(8) }} color={t.accent} />}
      {!loading && scored.length === 0 && <EmptyState icon={mode.icon} message={mode.emptyState} />}
      {byRound.map(({ round, events }) =>
        events.length === 0 ? null : (
          <View key={round}>
            <SectionHeader title={round + (events.length > 1 ? 's' : '')} />
            {events.map((event) => (
              <Card key={event.id}>
                <Text
                  style={{ color: t.text, fontWeight: '800', fontSize: 15, marginBottom: spacing(1) }}
                  onPress={() => router.push(`/event/${mode.id}/${event.id}`)}
                >
                  {event.region ? `${event.region} · ` : ''}
                  {event.name.replace(/^IC[CH]SA /, '')} →
                </Text>
                {event.sessions[0]?.results.map((r) => (
                  <ScoreRow
                    key={r.ensembleId}
                    rank={r.rank}
                    name={r.ensembleName}
                    points={r.points}
                    advanced={r.advanced}
                    awards={r.awards}
                    onPress={() => router.push(`/ensemble/${mode.id}/${r.ensembleId}`)}
                  />
                ))}
              </Card>
            ))}
          </View>
        ),
      )}
    </>
  );
}

export default function Scoreboard() {
  const t = useTheme();
  const { mode, segment, setSegment, hydrated } = useMode();
  if (!hydrated) return <View style={{ flex: 1, backgroundColor: t.page }} />;
  const behavior = segment.rankingBehavior;
  return (
    <View style={{ flex: 1, backgroundColor: t.page }}>
      <AppHeader subtitle={mode.name} />
      <ScrollView contentContainerStyle={{ paddingBottom: spacing(8) }}>
        {mode.segments.length > 1 && (
          <ChipRow>
            {mode.segments.map((s) => (
              <Chip
                key={s.id}
                label={s.name}
                active={s.id === segment.id}
                color={mode.accent}
                onPress={() => setSegment(s.id)}
              />
            ))}
          </ChipRow>
        )}
        {behavior === 'seasonLeaderboard' && <LeaderboardView />}
        {behavior === 'eventBased' && <EventResultsView />}
        {behavior === 'tournament' && <TournamentView />}
      </ScrollView>
    </View>
  );
}
