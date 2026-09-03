export type ChartValue = number | null;

export interface ChartSeries {
  label: string;
  values: ChartValue[];
  color?: string;
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}

export const CHART_COLORS = [
  "#d9ff68",
  "#8fb8ff",
  "#f4c66b",
  "#d19aff",
  "#70e2a0",
  "#ff9b9b",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readChartDataPath(value: unknown, path: string): unknown {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current = value;

  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }

  return current;
}

export function resolveChartEndpoint(endpoint: string, baseUrl: string): string | null {
  try {
    const url = new URL(endpoint, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseValues(value: unknown): ChartValue[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) =>
    typeof item === "number" && Number.isFinite(item) ? item : null,
  );
}

function parseSeries(value: unknown): ChartSeries[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!isRecord(item) || typeof item.label !== "string") return [];
      const values = parseValues(item.values);
      if (values === null) return [];
      return [
        {
          label: item.label,
          values,
          ...(typeof item.color === "string" && item.color.length > 0
            ? { color: item.color }
            : {}),
        },
      ];
    });
  }

  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([label, values]) => {
    const parsed = parseValues(values);
    return parsed === null ? [] : [{ label, values: parsed }];
  });
}

export function parseChartData(value: unknown): ChartData | null {
  if (!isRecord(value)) return null;

  const series = parseSeries(value.series);
  if (series.length === 0 && Object.hasOwn(value, "values")) {
    const values = parseValues(value.values);
    if (values !== null) {
      series.push({
        label: typeof value.label === "string" ? value.label : "Value",
        values,
      });
    }
  }
  if (series.length === 0) return null;

  const pointCount = Math.max(...series.map((item) => item.values.length), 0);
  if (pointCount === 0) return null;

  const labels = Array.isArray(value.labels)
    ? value.labels.map((label, index) =>
        typeof label === "string" && label.length > 0 ? label : `Point ${index + 1}`,
      )
    : [];
  while (labels.length < pointCount) labels.push(`Point ${labels.length + 1}`);

  return {
    labels: labels.slice(0, pointCount),
    series,
  };
}

export function limitChartData(data: ChartData, maxPoints = 60): ChartData {
  const pointCount = Math.max(2, Math.floor(maxPoints));
  if (data.labels.length <= pointCount) return data;
  const start = data.labels.length - pointCount;
  return {
    labels: data.labels.slice(start),
    series: data.series.map((series) => ({
      ...series,
      values: series.values.slice(start),
    })),
  };
}
