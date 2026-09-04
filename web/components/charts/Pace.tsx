'use client';
import { useMemo } from 'react';
import { useRtl } from '@/components/ui';

const W = 300;   // viewBox units only -- the rendered width is always 100% of the container
const H = 72;

/**
 * Reading pace over a window: the daily count as a faint area, and a rolling mean as the line you read.
 *
 * The raw daily series is almost unreadable on its own -- reading is bursty, so it is a picket fence of
 * zeroes and spikes. The mean is what shows whether you are speeding up or drifting off, and the area
 * behind it keeps the individual days honest so the smoothing cannot hide a fortnight of nothing.
 *
 * `width="100%"` with a viewBox, so this is fluid by construction at any width including 390px.
 *
 * RTL reverses the DATA -- oldest on the right -- and leaves the drawing alone. Mirroring the group would
 * mirror the axis labels the caller puts beside it.
 */
export function Pace({ values, window: win = 7 }: { values: number[]; window?: number }) {
  const rtl = useRtl();
  const { area, line, peak } = useMemo(() => {
    const src = rtl ? [...values].reverse() : values;
    const n = src.length;
    if (!n) return { area: '', line: '', peak: 0 };

    // Trailing mean: each point averages the `win` days up to and including itself, so the line never
    // depends on days that have not happened yet.
    const mean = src.map((_, i) => {
      const from = Math.max(0, i - win + 1);
      let sum = 0;
      for (let k = from; k <= i; k++) sum += src[k];
      return sum / (i - from + 1);
    });

    const peak = Math.max(1, ...src);
    const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v: number) => H - (v / peak) * (H - 2) - 1;

    const line = mean.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const area = `M0,${H} ` + src.map((v, i) => `L${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ') + ` L${W},${H} Z`;
    return { area, line, peak };
  }, [values, win, rtl]);

  if (!values.length) return null;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={`Reading pace, peak ${peak} in a day`} className="block h-[72px] w-full">
      <path d={area} fill="rgb(var(--accent) / 0.14)" />
      {/* `vector-effect` so the stroke stays 1.5px after the viewBox is stretched to the container width --
          without it a 300-unit box in a 1200px column draws a 6px line. */}
      <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth={1.5} strokeLinejoin="round"
        strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
