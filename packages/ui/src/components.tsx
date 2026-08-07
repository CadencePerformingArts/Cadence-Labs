import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { Division, Provenance } from '@cadence/domain';
import { formatDelta, formatScore } from '@cadence/domain';
import { radius, spacing, type, useTheme } from './index';

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          padding: spacing(3),
          marginHorizontal: spacing(3),
          marginBottom: spacing(2.5),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing(4),
        paddingTop: spacing(3),
        paddingBottom: spacing(1.5),
      }}
    >
      <Text
        style={{
          color: t.textSecondary,
          fontSize: type.small,
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: 0.8,
        }}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}

export function Badge({
  label,
  color,
  filled,
}: {
  label: string;
  color?: string;
  filled?: boolean;
}) {
  const t = useTheme();
  const tint = color ?? t.navy;
  return (
    <View
      style={{
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 1.5,
        backgroundColor: filled ? tint : 'transparent',
        borderWidth: 1,
        borderColor: tint,
      }}
    >
      <Text
        style={{
          color: filled ? '#ffffff' : tint,
          fontSize: type.tiny,
          fontWeight: '800',
          letterSpacing: 0.4,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

const KIND_LABEL: Record<Provenance['kind'], string> = {
  live: 'LIVE',
  snapshot: 'SNAPSHOT',
  fixture: 'DEMO DATA',
};

/** Always-visible data honesty: what the numbers are and when they were captured. */
export function FreshnessBadge({ provenance }: { provenance: Provenance }) {
  const t = useTheme();
  const color =
    provenance.kind === 'live' ? t.positive : provenance.kind === 'snapshot' ? t.accent : t.muted;
  const date = provenance.fetchedAt.slice(0, 10);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: t.muted, fontSize: type.tiny, fontWeight: '600' }}>
        {KIND_LABEL[provenance.kind]} · {provenance.sourceName} · {date}
      </Text>
    </View>
  );
}

export function Sparkline({ points, color }: { points: number[]; color?: string }) {
  const t = useTheme();
  if (points.length < 2) return <View style={{ width: 56, height: 20 }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  return (
    <View style={{ width: 56, height: 20, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {points.slice(-8).map((p, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: 4 + ((p - min) / range) * 15,
            borderRadius: 1.5,
            backgroundColor: color ?? t.gold,
            opacity: 0.45 + (i / Math.max(points.length - 1, 1)) * 0.55,
          }}
        />
      ))}
    </View>
  );
}

export interface ScoreRowProps {
  rank?: number;
  name: string;
  division?: Division;
  score?: number;
  points?: number;
  delta?: number;
  sub?: string;
  trend?: number[];
  favorite?: boolean;
  advanced?: boolean;
  awards?: string[];
  onPress?: () => void;
  onToggleFavorite?: () => void;
}

export function ScoreRow(props: ScoreRowProps) {
  const t = useTheme();
  const value =
    props.points !== undefined
      ? `${props.points} pts`
      : formatScore(props.score);
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing(2),
        paddingHorizontal: spacing(1),
        opacity: pressed ? 0.65 : 1,
        gap: spacing(2),
      })}
    >
      {props.rank !== undefined && (
        <Text
          style={{
            width: 26,
            color: props.rank <= 3 ? t.accent : t.muted,
            fontWeight: '800',
            fontSize: type.body,
            textAlign: 'center',
          }}
        >
          {props.rank}
        </Text>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: type.body }} numberOfLines={1}>
            {props.name}
          </Text>
          {props.division && <Badge label={props.division.short} />}
          {props.advanced && <Badge label="ADV" color={t.positive} />}
        </View>
        {props.sub ? (
          <Text style={{ color: t.muted, fontSize: type.tiny }} numberOfLines={1}>
            {props.sub}
          </Text>
        ) : null}
        {props.awards && props.awards.length > 0 ? (
          <Text style={{ color: t.accent, fontSize: type.tiny, fontWeight: '600' }} numberOfLines={2}>
            🏆 {props.awards.join(' · ')}
          </Text>
        ) : null}
      </View>
      {props.trend && <Sparkline points={props.trend} />}
      <View style={{ alignItems: 'flex-end', minWidth: 64 }}>
        <Text style={{ color: t.text, fontWeight: '800', fontSize: type.score, fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        {props.delta !== undefined && (
          <Text
            style={{
              color: props.delta >= 0 ? t.positive : t.negative,
              fontSize: type.tiny,
              fontWeight: '700',
            }}
          >
            {formatDelta(props.delta)}
          </Text>
        )}
      </View>
      {props.onToggleFavorite && (
        <Pressable onPress={props.onToggleFavorite} hitSlop={10}>
          <Text style={{ fontSize: 18, opacity: props.favorite ? 1 : 0.55 }}>
            {props.favorite ? '★' : '☆'}
          </Text>
        </Pressable>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  active,
  onPress,
  color,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  color?: string;
}) {
  const t = useTheme();
  const tint = color ?? t.navy;
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: spacing(3),
        paddingVertical: spacing(1.5),
        borderRadius: 999,
        backgroundColor: active ? tint : t.surfaceAlt,
        borderWidth: 1,
        borderColor: active ? tint : t.border,
      }}
    >
      <Text
        style={{
          color: active ? '#ffffff' : t.textSecondary,
          fontWeight: '700',
          fontSize: type.small,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing(2), paddingHorizontal: spacing(3), paddingVertical: spacing(2) }}
    >
      {children}
    </ScrollView>
  );
}

export function StatCard({
  icon,
  label,
  headline,
  detail,
}: {
  icon: string;
  label: string;
  headline: string;
  detail: string;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.surface,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.border,
        padding: spacing(3),
        gap: 3,
      }}
    >
      <Text style={{ fontSize: type.tiny, fontWeight: '800', color: t.muted, letterSpacing: 0.7 }}>
        {icon} {label.toUpperCase()}
      </Text>
      <Text style={{ fontSize: type.body, fontWeight: '800', color: t.text }} numberOfLines={1}>
        {headline}
      </Text>
      <Text style={{ fontSize: type.tiny, color: t.textSecondary }} numberOfLines={2}>
        {detail}
      </Text>
    </View>
  );
}

export function EmptyState({ icon, message }: { icon: string; message: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: spacing(10), gap: spacing(2) }}>
      <Text style={{ fontSize: 40 }}>{icon}</Text>
      <Text style={{ color: t.muted, fontSize: type.body, textAlign: 'center' }}>{message}</Text>
    </View>
  );
}
