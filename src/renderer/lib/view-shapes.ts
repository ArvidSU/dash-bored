import { parseChartData, type ChartData } from "./chart-data";

export type StatusValue = { state: "unknown" | "healthy" | "warning" | "error"; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStatusValue(value: unknown): StatusValue | null {
  if (!isRecord(value)) return null;
  const states = ["unknown", "healthy", "warning", "error"] as const;
  if (states.includes(value.state as StatusValue["state"])) {
    if (value.detail !== undefined && typeof value.detail !== "string") return null;
    return { state: value.state as StatusValue["state"], ...(typeof value.detail === "string" ? { detail: value.detail } : {}) };
  }
  if (value.phase === "idle" || value.phase === "running" || value.phase === "stopping" || value.phase === "exited" || value.phase === "failed") {
    const state: StatusValue["state"] = value.phase === "idle" ? "unknown"
      : value.phase === "running" || value.phase === "stopping" ? "warning"
        : value.exitCode === 0 ? "healthy" : "error";
    const detail = typeof value.exitCode === "number" ? `Exit code ${value.exitCode}` : `Process ${String(value.phase)}`;
    return { state, detail };
  }
  return null;
}

export function parseSourceChart(value: unknown): ChartData | null {
  if (!isRecord(value) || !Array.isArray(value.labels) || !value.labels.every((label) => typeof label === "string")) return null;
  if (!Array.isArray(value.series) || value.series.length === 0) return null;
  if (!value.series.every((series) => isRecord(series)
    && typeof series.label === "string"
    && Array.isArray(series.values)
    && series.values.every((item) => item === null || (typeof item === "number" && Number.isFinite(item))))) return null;
  const parsed = parseChartData(value);
  if (!parsed || parsed.labels.length !== value.labels.length || parsed.series.length !== value.series.length) return null;
  return parsed;
}
