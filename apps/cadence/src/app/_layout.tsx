import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider, useTheme } from '@cadence/ui';
import { ModeProvider } from '../state/ModeContext';

function RootStack() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.headerBg },
        headerTintColor: t.headerText,
        headerTitleStyle: { fontWeight: '800' },
        contentStyle: { backgroundColor: t.page },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="switch-mode"
        options={{ presentation: 'modal', title: 'Switch mode' }}
      />
      <Stack.Screen name="event/[mode]/[id]" options={{ title: 'Event' }} />
      <Stack.Screen name="ensemble/[mode]/[id]" options={{ title: 'Profile' }} />
      <Stack.Screen name="records" options={{ title: 'All-Time Records' }} />
      <Stack.Screen name="compare" options={{ title: 'Compare' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ModeProvider>
          <StatusBar style="light" />
          <RootStack />
        </ModeProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
