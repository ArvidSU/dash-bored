import type { ReactNode } from "react";
import { StateGlyph, stateTone } from "./state-visual";

export type TrendDirection = "rising" | "falling" | "steady";

function finite(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

/** Compare the mean of the newer half with the older half, so one spike does not flip direction. */
export function trendDirection(values: ReadonlyArray<number | null>): TrendDirection {
  const middle = Math.floor(values.length / 2);
  const older = finite(values.slice(0, middle));
  const newer = finite(values.slice(values.length - middle));
  if (older.length === 0 || newer.length === 0) return "steady";
  const mean = (entries: number[]) => entries.reduce((sum, entry) => sum + entry, 0) / entries.length;
  const all = finite(values);
  const range = Math.max(...all) - Math.min(...all);
  const delta = mean(newer) - mean(older);
  if (range === 0 || Math.abs(delta) < range * 0.1) return "steady";
  return delta > 0 ? "rising" : "falling";
}

export function trendSummary(values: ReadonlyArray<number | null>): string {
  const all = finite(values);
  const latest = [...values].reverse().find((value): value is number => typeof value === "number");
  const gaps = values.length - all.length;
  return `${trendDirection(values)} over ${values.length} points; latest ${latest ?? "unknown"}, low ${Math.min(...all)}, high ${Math.max(...all)}${gaps ? `, ${gaps} missing` : ""}`;
}

/** A small line of recent observations. Direction is stated in text beside it. */
export function Sparkline({ values, className = "glance-sparkline" }: { values: ReadonlyArray<number | null>; className?: string }): ReactNode {
  const width = 72;
  const height = 22;
  const pad = 2.5;
  const all = finite(values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (index: number) => pad + (values.length <= 1 ? 0 : index / (values.length - 1)) * (width - pad * 2);
  const y = (value: number) => max === min ? height / 2 : pad + (max - value) / span * (height - pad * 2);
  const segments: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (typeof value !== "number") {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? " L" : "M"} ${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.length - 1 - [...values].reverse().findIndex((value) => typeof value === "number");
  const last = values[lastIndex];
  const direction = trendDirection(values);
  return <span className={className} data-direction={direction}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend ${trendSummary(values)}`}>
      <path className="glance-sparkline__line" d={segments.join(" ")} />
      {typeof last === "number" ? <circle className="glance-sparkline__last" cx={x(lastIndex)} cy={y(last)} r="2.2" /> : null}
    </svg>
    <span className="glance-sparkline__direction" aria-hidden="true">{direction === "rising" ? "↗" : direction === "falling" ? "↘" : "→"} {direction}</span>
  </span>;
}

export type MeterSegment = { label: string; value: number; state?: string };

function percent(value: number, total: number): number {
  return total > 0 ? Math.round(value / total * 100) : 0;
}

/** Parts of one whole: the bar is decorative; the legend carries every value as text. */
export function SegmentMeter({ segments, label }: { segments: readonly MeterSegment[]; label: string }): ReactNode {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return <div className="glance-meter" role="group" aria-label={`${label}: ${total} total`}>
    <div className="glance-meter__bar" aria-hidden="true">
      {total > 0 ? segments.map((segment, index) => segment.value > 0
        ? <span key={`${segment.label}-${index}`} data-tone={stateTone(segment.state)} style={{ flexGrow: segment.value }} />
        : null) : <span data-tone="empty" style={{ flexGrow: 1 }} />}
    </div>
    <ul className="glance-meter__legend">
      {segments.map((segment, index) => <li key={`${segment.label}-${index}`} data-tone={stateTone(segment.state)}>
        <StateGlyph tone={stateTone(segment.state)} />
        <span>{segment.label} {segment.value}</span>
        <small>{percent(segment.value, total)}%</small>
      </li>)}
    </ul>
  </div>;
}
