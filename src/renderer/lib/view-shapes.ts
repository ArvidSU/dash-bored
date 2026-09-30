import type { ProcessSnapshot } from "../../shared/contracts";
import { processRun, processRunFailed } from "../../shared/process-state";
import { parseChartData, type ChartData } from "./chart-data";

export type StatusSegment = { label: string; value: number; state?: string };
export type StatusValue = {
  state: "unknown" | "healthy" | "warning" | "error";
  detail?: string;
  /** Recent observations, oldest first; null marks a gap such as a failed read. */
  trend?: Array<number | null>;
  /** Parts of one whole, such as done and open work. */
  segments?: StatusSegment[];
};

export const STATUS_TREND_MAX_POINTS = 60;
export const STATUS_SEGMENTS_MAX = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrend(value: unknown): Array<number | null> | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > STATUS_TREND_MAX_POINTS) return null;
  if (!value.every((point) => point === null || typeof point === "number" && Number.isFinite(point))) return null;
  return value.some((point) => point !== null) ? value as Array<number | null> : null;
}

function parseSegments(value: unknown): StatusSegment[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > STATUS_SEGMENTS_MAX) return null;
  const segments: StatusSegment[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.label !== "string" || !entry.label.trim()) return null;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value < 0) return null;
    if (entry.state !== undefined && typeof entry.state !== "string") return null;
    segments.push({ label: entry.label, value: entry.value, ...(typeof entry.state === "string" ? { state: entry.state } : {}) });
  }
  return segments;
}

export function parseStatusValue(value: unknown): StatusValue | null {
  if (!isRecord(value)) return null;
  const states = ["unknown", "healthy", "warning", "error"] as const;
  if (states.includes(value.state as StatusValue["state"])) {
    if (value.detail !== undefined && typeof value.detail !== "string") return null;
    const trend = parseTrend(value.trend);
    const segments = parseSegments(value.segments);
    if (trend === null || segments === null) return null;
    return {
      state: value.state as StatusValue["state"],
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
      ...(trend ? { trend } : {}),
      ...(segments ? { segments } : {}),
    };
  }
  if (isProcessPhase(value.phase)) {
    // A supervised process snapshot: observe its latest run, never the
    // lifetime of an interactive terminal that stays open between runs.
    const run = processRun(value as unknown as ProcessSnapshot);
    if (run === undefined) {
      return { state: "unknown", detail: value.phase === "idle" ? "Not run yet" : "Terminal open; not run yet" };
    }
    if (run.phase === "running" || run.phase === "stopping") {
      return { state: "warning", detail: run.phase === "running" ? "Running" : "Stopping" };
    }
    const detail = run.signal !== null ? `Stopped by ${run.signal}`
      : typeof run.exitCode === "number" ? `Exit code ${run.exitCode}`
        : run.phase === "failed" ? "Failed to start" : "Process exited";
    return { state: processRunFailed(run) ? "error" : "healthy", detail };
  }
  return null;
}

function isProcessPhase(value: unknown): value is ProcessSnapshot["phase"] {
  return value === "idle" || value === "running" || value === "stopping" || value === "exited" || value === "failed";
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
