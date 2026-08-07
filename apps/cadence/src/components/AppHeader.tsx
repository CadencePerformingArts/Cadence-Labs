import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { brand, spacing, type, useTheme } from '@cadence/ui';
import { useMode } from '../state/ModeContext';

/**
 * The Cadence shell header: wordmark, current mode, and the global mode
 * switcher — present on every top-level screen in every mode.
 */
export function AppHeader({ subtitle }: { subtitle?: string }) {
  const t = useTheme();
  const router = useRouter();
  const { mode } = useMode();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        backgroundColor: t.headerBg,
        paddingTop: insets.top + spacing(2),
        paddingBottom: spacing(2.5),
        paddingHorizontal: spacing(4),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <View>
        <Text style={{ color: t.headerText, fontSize: type.title, fontWeight: '900', letterSpacing: 0.5 }}>
          Cadence<Text style={{ color: brand.gold }}>.</Text>
        </Text>
        {subtitle ? (
          <Text style={{ color: '#c9d6e5', fontSize: type.tiny, fontWeight: '600' }}>{subtitle}</Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => router.push('/switch-mode')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: 'rgba(255,255,255,0.12)',
          borderRadius: 999,
          paddingHorizontal: spacing(3),
          paddingVertical: spacing(1.5),
          opacity: pressed ? 0.7 : 1,
          borderWidth: 1,
          borderColor: mode.accent,
        })}
      >
        <Text style={{ fontSize: 14 }}>{mode.icon}</Text>
        <Text style={{ color: t.headerText, fontWeight: '800', fontSize: type.small }}>
          {mode.shortName}
        </Text>
        <Text style={{ color: '#c9d6e5', fontSize: 10 }}>▼</Text>
      </Pressable>
    </View>
  );
}
