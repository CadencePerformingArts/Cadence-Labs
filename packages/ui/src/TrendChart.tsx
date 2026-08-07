import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import type { TrendPoint } from '@cadence/domain';
import { spacing, type, useTheme } from './index';

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
