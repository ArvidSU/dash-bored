import type { ReactNode } from "react";
import "./chart.css";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";
import {
  CHART_COLORS,
  limitChartData,
  parseChartData,
  type ChartData,
  type ChartSeries,
  type ChartValue,
} from "../../lib/chart-data";

export type ChartType = "line" | "bar";

export function numberProp(
  props: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function chartType(props: Record<string, unknown>): ChartType {
  return props.type === "bar" ? "bar" : "line";
}

export function chartTitle(props: Record<string, unknown>, fallback: string): string {
  return stringProp(props, ["title"], fallback);
}

function chartColor(series: ChartSeries, index: number): string {
  return series.color ?? CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}

function formatChartValue(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function chartPath(
  values: ChartValue[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const segments: string[] = [];
  let segment: string[] = [];

  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (segment.length > 0) segments.push(segment.join(" "));
      segment = [];
      return;
    }
    const command = segment.length === 0 ? "M" : "L";
    segment.push(`${command} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`);
  });
  if (segment.length > 0) segments.push(segment.join(" "));
  return segments.join(" ");
}

function ChartSvg({
  data,
  type,
  title,
}: {
  data: ChartData;
  type: ChartType;
  title: string;
}): ReactNode {
  const width = 720;
  const height = 280;
  const padding = { top: 18, right: 18, bottom: 42, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = data.series.flatMap((series) =>
    series.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );

  if (values.length === 0) {
    return <div className="component-state">Waiting for numeric chart values.</div>;
  }

  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    const paddingValue = Math.max(Math.abs(min) * 0.15, 1);
    min -= paddingValue;
    max += paddingValue;
  }

  const x = (index: number): number =>
    data.labels.length <= 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (data.labels.length - 1)) * plotWidth;
  const y = (value: number): number =>
    padding.top + ((max - value) / (max - min)) * plotHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = max - ((max - min) * index) / 4;
    return { value, y: y(value) };
  });
  const labelIndexes =
    data.labels.length <= 8
      ? data.labels.map((_, index) => index)
      : [...new Set([0, Math.floor((data.labels.length - 1) / 2), data.labels.length - 1])];
  const barGroupWidth = plotWidth / Math.max(data.labels.length, 1);
  const barWidth = Math.max(
    2,
    Math.min(26, (barGroupWidth * 0.72) / Math.max(data.series.length, 1)),
  );

  return (
    <svg
      className="chart__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title}, ${data.series.length} series over ${data.labels.length} points`}
    >
      <title>{title}</title>
      {ticks.map((tick) => (
        <g key={tick.value}>
          <line
            className="chart__grid"
            x1={padding.left}
            x2={width - padding.right}
            y1={tick.y}
            y2={tick.y}
          />
          <text className="chart__axis-label" x={padding.left - 9} y={tick.y + 3} textAnchor="end">
            {formatChartValue(tick.value)}
          </text>
        </g>
      ))}
      <line
        className="chart__axis"
        x1={padding.left}
        x2={width - padding.right}
        y1={padding.top + plotHeight}
        y2={padding.top + plotHeight}
      />
      {type === "line"
        ? data.series.map((series, seriesIndex) => (
            <g key={series.label}>
              <path
                className="chart__line"
                d={chartPath(series.values, x, y)}
                stroke={chartColor(series, seriesIndex)}
              />
              {series.values.map((value, index) =>
                typeof value === "number" && Number.isFinite(value) ? (
                  <circle
                    className="chart__point"
                    cx={x(index)}
                    cy={y(value)}
                    fill={chartColor(series, seriesIndex)}
                    key={index}
                    r="3"
                  />
                ) : null,
              )}
            </g>
          ))
        : data.series.map((series, seriesIndex) =>
            series.values.map((value, index) => {
              if (typeof value !== "number" || !Number.isFinite(value)) return null;
              const barX =
                padding.left +
                index * barGroupWidth +
                (barGroupWidth - barWidth * data.series.length) / 2 +
                seriesIndex * barWidth;
              const zeroY = y(0);
              const valueY = y(value);
              return (
                <rect
                  className="chart__bar"
                  fill={chartColor(series, seriesIndex)}
                  height={Math.max(Math.abs(zeroY - valueY), 1)}
                  key={`${series.label}-${index}`}
                  rx="2"
                  width={Math.max(barWidth - 2, 1)}
                  x={barX}
                  y={Math.min(zeroY, valueY)}
                />
              );
            }),
          )}
      {labelIndexes.map((index) => (
        <text
          className="chart__x-label"
          key={index}
          x={x(index)}
          y={height - 13}
          textAnchor={index === 0 ? "start" : index === data.labels.length - 1 ? "end" : "middle"}
        >
          {data.labels[index]}
        </text>
      ))}
    </svg>
  );
}

export function ChartPanel({
  data,
  error,
  loading,
  onRefresh,
  status,
  title,
  type,
  updatedAt,
}: {
  data: ChartData | null;
  error?: string | null;
  loading?: boolean;
  onRefresh?: () => void;
  status?: string;
  title: string;
  type: ChartType;
  updatedAt?: Date | null;
}): ReactNode {
  return (
    <section className="chart" aria-label={title}>
      <header className="chart__header">
        <div className="chart__heading">
          <strong>{title}</strong>
          {status ? <span>{status}</span> : null}
        </div>
        {onRefresh ? (
          <button className="button button--quiet button--small" type="button" onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </header>
      {error ? <div className="chart__error" role="alert">{error}</div> : null}
      {data ? (
        <ChartSvg data={data} title={title} type={type} />
      ) : (
        <div className="component-state">{loading ? "Loading chart data…" : "No chart data yet."}</div>
      )}
      {data ? (
        <footer className="chart__footer">
          <div className="chart__legend">
            {data.series.map((series, index) => (
              <span className="chart__legend-item" key={series.label}>
                <i style={{ backgroundColor: chartColor(series, index) }} />
                {series.label}
              </span>
            ))}
          </div>
          {updatedAt ? <span>Updated {updatedAt.toLocaleTimeString()}</span> : null}
        </footer>
      ) : null}
    </section>
  );
}

export default function Chart({ props }: ComponentRendererProps): ReactNode {
  const rawData = parseChartData({ labels: props.labels, series: props.series });
  const data = rawData
    ? limitChartData(rawData, numberProp(props, "maxPoints", 60))
    : null;
  return (
    <ChartPanel
      data={data}
      status={chartType(props)}
      title={chartTitle(props, "Chart")}
      type={chartType(props)}
    />
  );
}
