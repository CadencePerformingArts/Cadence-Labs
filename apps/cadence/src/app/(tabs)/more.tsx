import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatScore } from '@cadence/domain';
import { Badge, Card, FreshnessBadge, SectionHeader, spacing, type, useTheme } from '@cadence/ui';
import { provider } from '@cadence/data';
import { AppHeader } from '../../components/AppHeader';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useMode } from '../../state/ModeContext';

function Row({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing(1.5), gap: spacing(3) }}>
      <Text style={{ color: t.textSecondary, fontSize: type.small }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: type.small, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

export default function More() {
  const t = useTheme();
  const router = useRouter();
  const { mode } = useMode();
  const { data: provenance } = useAsyncData(() => provider.getProvenance(mode.id), [mode.id]);
  const { data: champions } = useAsyncData(() => provider.getChampions(mode.id), [mode.id]);
  const recentChampions = (champions ?? []).filter((c) => c.divisionId === 'world').slice(0, 12);

  return (
    <View style={{ flex: 1, backgroundColor: t.page }}>
      <AppHeader subtitle="Settings & info" />
      <ScrollView contentContainerStyle={{ paddingTop: spacing(2), paddingBottom: spacing(8) }}>
        <SectionHeader title="Data" />
        <Card>
          {provenance && (
            <View style={{ marginBottom: spacing(2) }}>
              <FreshnessBadge provenance={provenance} />
            </View>
          )}
          <Text style={{ color: t.textSecondary, fontSize: type.small, lineHeight: 19 }}>
            {mode.dataSourceNote}
          </Text>
        </Card>

        {(champions ?? []).length > 0 && (
          <>
            <SectionHeader title="History" />
            <Card>
              <Text
                style={{ color: t.text, fontWeight: '800', fontSize: type.body }}
                onPress={() => router.push('/records')}
              >
                📜 All-time record scores →
              </Text>
              <Text style={{ color: t.textSecondary, fontSize: type.small, marginTop: 4 }}>
                The highest scores ever posted, by class — real data back to 1972.
              </Text>
            </Card>
          </>
        )}
        {recentChampions.length > 0 && (
          <>
            <SectionHeader title="World Class Champions" />
            <Card>
              {recentChampions.map((c) => (
                <Row
                  key={c.season}
                  label={c.season}
                  value={`${c.name}${c.score ? ` — ${formatScore(c.score)}` : ''}`}
                />
              ))}
            </Card>
          </>
        )}

        <SectionHeader title="Account" />
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing(1) }}>
            <Text style={{ color: t.text, fontWeight: '800', fontSize: type.body }}>Cadence account</Text>
            <Badge label="COMING SOON" color={t.muted} />
          </View>
          <Text style={{ color: t.textSecondary, fontSize: type.small, lineHeight: 19 }}>
            Accounts add cross-device favorites sync, notifications and Cadence+. Public scores
            will always be free to browse without signing in.
          </Text>
        </Card>

        <SectionHeader title="Cadence+" />
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing(1) }}>
            <Text style={{ color: t.text, fontWeight: '800', fontSize: type.body }}>
              Cadence<Text style={{ color: t.gold }}>+</Text>
            </Text>
            <Badge label="PREVIEW" color={t.gold} />
          </View>
          <Text style={{ color: t.textSecondary, fontSize: type.small, lineHeight: 19 }}>
            Unlimited favorites, advanced caption analysis, full historical exploration, saved
            comparisons and richer alerts. Billing is not enabled in this build — nothing here
            charges money.
          </Text>
        </Card>

        <SectionHeader title="About" />
        <Card>
          <Row label="App" value="Cadence (preview build)" />
          <Row label="Mode" value={mode.name} />
          <Row label="Theme" value={t.dark ? 'Dark (follows system)' : 'Light (follows system)'} />
          <Text style={{ color: t.muted, fontSize: type.tiny, marginTop: spacing(2), lineHeight: 16 }}>
            Cadence is an unofficial fan project and is not affiliated with DCI, WGI, Music for
            All, Varsity Vocals or any competition circuit. Scores belong to their sources and are
            credited on every surface where they appear.
          </Text>
        </Card>
      </ScrollView>
    </View>
  );
}
