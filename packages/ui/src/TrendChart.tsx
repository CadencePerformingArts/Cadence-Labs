import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import type { TrendPoint } from '@cadence/domain';
import { spacing, type, useTheme } from './index';

export interface TrendSeries {
  name: string;
  color: string;
  points: TrendPoint[];
}

/** Overlaid season-progression lines for comparing ensembles head-to-head. */
export function MultiTrendChart({
  series,
  height = 200,
  width = 320,
}: {
  series: TrendSeries[];
  height?: number;
  width?: number;
}) {
  const t = useTheme();
  const populated = series.filter((s) => s.points.length > 0);
  if (populated.length === 0) return null;
  const pad = { top: 14, bottom: 10, left: 38, right: 14 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const all = populated.flatMap((s) => s.points);
  const scores = all.map((p) => p.score);
  const times = all.map((p) => new Date(p.date).getTime());
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const rangeS = maxS - minS || 1;
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const rangeT = maxT - minT || 1;
  const x = (d: string) => pad.left + ((new Date(d).getTime() - minT) / rangeT) * w;
  const y = (s: number) => pad.top + h - ((s - minS) / rangeS) * h;
  const grid = [minS, minS + rangeS / 2, maxS];
  return (
    <View>
      <Svg width={width} height={height}>
        {grid.map((g, i) => (
          <React.Fragment key={i}>
            <Line x1={pad.left} y1={y(g)} x2={width - pad.right} y2={y(g)} stroke={t.border} strokeWidth={1} />
            <SvgText x={4} y={y(g) + 4} fontSize={10} fill={t.muted}>
              {g.toFixed(1)}
            </SvgText>
          </React.Fragment>
        ))}
        {populated.map((s) => (
          <React.Fragment key={s.name}>
            <Path
              d={s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')}
              stroke={s.color}
              strokeWidth={2.5}
              fill="none"
            />
            {s.points.map((p, i) => (
              <Circle key={i} cx={x(p.date)} cy={y(p.score)} r={2.5} fill={s.color} />
            ))}
          </React.Fragment>
        ))}
      </Svg>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing(3), paddingHorizontal: spacing(2), paddingTop: spacing(1) }}>
        {populated.map((s) => (
          <View key={s.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: s.color }} />
            <Text style={{ color: t.textSecondary, fontSize: type.tiny, fontWeight: '600' }}>{s.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Season progression line chart — the signature Cadence visual. Pure SVG so
 * it renders identically on iOS, Android and web.
 */
export function TrendChart({
  points,
  height = 160,
  width = 320,
  color,
}: {
  points: TrendPoint[];
  height?: number;
  width?: number;
  color?: string;
}) {
  const t = useTheme();
  const stroke = color ?? t.gold;
  if (points.length === 0) return null;
  const pad = { top: 14, bottom: 24, left: 38, right: 14 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const scores = points.map((p) => p.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const x = (i: number) =>
    pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (s: number) => pad.top + h - ((s - min) / range) * h;
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`)
    .join(' ');
  const gridLines = [min, min + range / 2, max];
  return (
    <View>
      <Svg width={width} height={height}>
        {gridLines.map((g, i) => (
          <React.Fragment key={i}>
            <Line
              x1={pad.left}
              y1={y(g)}
              x2={width - pad.right}
              y2={y(g)}
              stroke={t.border}
              strokeWidth={1}
            />
            <SvgText x={4} y={y(g) + 4} fontSize={10} fill={t.muted}>
              {g.toFixed(1)}
            </SvgText>
          </React.Fragment>
        ))}
        <Path d={path} stroke={stroke} strokeWidth={2.5} fill="none" />
        {points.map((p, i) => (
          <Circle key={i} cx={x(i)} cy={y(p.score)} r={3} fill={stroke} />
        ))}
      </Svg>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingHorizontal: spacing(2),
        }}
      >
        <Text style={{ color: t.muted, fontSize: type.tiny }}>{points[0].date}</Text>
        <Text style={{ color: t.muted, fontSize: type.tiny }}>
          {points[points.length - 1].date}
        </Text>
      </View>
    </View>
  );
}
