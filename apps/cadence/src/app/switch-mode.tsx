import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MODES } from '@cadence/domain';
import { Badge, radius, spacing, type, useTheme } from '@cadence/ui';
import { useMode } from '../state/ModeContext';

const STATUS_LABEL = { live: 'LIVE', snapshot: 'REAL DATA', fixture: 'DEMO' } as const;

/** Global mode switcher — reachable from the header on every screen. */
export default function SwitchMode() {
  const t = useTheme();
  const router = useRouter();
  const { mode: active, setMode } = useMode();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.page }} contentContainerStyle={{ padding: spacing(3) }}>
      {MODES.map((mode) => {
        const isActive = mode.id === active.id;
        return (
          <Pressable
            key={mode.id}
            onPress={() => {
              setMode(mode.id);
              router.back();
            }}
            style={({ pressed }) => ({
              backgroundColor: t.surface,
              borderRadius: radius.md,
              borderWidth: isActive ? 2 : 1,
              borderColor: isActive ? mode.accent : t.border,
              padding: spacing(3.5),
              marginBottom: spacing(2.5),
              opacity: pressed ? 0.7 : 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing(3),
            })}
          >
            <Text style={{ fontSize: 30 }}>{mode.icon}</Text>
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: t.text, fontWeight: '800', fontSize: type.heading }}>
                  {mode.name}
                </Text>
                <Badge
                  label={STATUS_LABEL[mode.dataStatus]}
                  color={mode.dataStatus === 'fixture' ? t.muted : t.positive}
                  filled={mode.dataStatus !== 'fixture'}
                />
              </View>
              <Text style={{ color: t.textSecondary, fontSize: type.small }}>{mode.tagline}</Text>
            </View>
            {isActive && <Text style={{ color: mode.accent, fontWeight: '900' }}>✓</Text>}
          </Pressable>
        );
      })}
      <Text style={{ color: t.muted, fontSize: type.tiny, textAlign: 'center', padding: spacing(2) }}>
        Your favorites, filters and last-viewed class are remembered separately for each mode.
      </Text>
    </ScrollView>
  );
}
