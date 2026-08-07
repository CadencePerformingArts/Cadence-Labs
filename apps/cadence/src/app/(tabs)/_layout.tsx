import React from 'react';
import { Text } from 'react-native';
import { Tabs } from 'expo-router';
import { useTheme } from '@cadence/ui';
import { useMode } from '../../state/ModeContext';

function tabIcon(glyph: string) {
  return ({ focused }: { focused: boolean }) => (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.45 }}>{glyph}</Text>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  const { mode } = useMode();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.dark ? t.gold : t.navy,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.tabBar, borderTopColor: t.border },
        tabBarLabelStyle: { fontWeight: '700', fontSize: 11 },
        sceneStyle: { backgroundColor: t.page },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: mode.terminology.scoreboard, tabBarIcon: tabIcon('🏆') }}
      />
      <Tabs.Screen
        name="events"
        options={{ title: mode.terminology.eventPlural, tabBarIcon: tabIcon('📅') }}
      />
      <Tabs.Screen
        name="ensembles"
        options={{ title: mode.terminology.ensemblePlural, tabBarIcon: tabIcon(mode.icon) }}
      />
      <Tabs.Screen name="favorites" options={{ title: 'Favorites', tabBarIcon: tabIcon('★') }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: tabIcon('⋯') }} />
    </Tabs>
  );
}
