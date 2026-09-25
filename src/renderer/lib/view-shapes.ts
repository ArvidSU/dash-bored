import type { ProcessSnapshot } from "../../shared/contracts";
import { processRun, processRunFailed } from "../../shared/process-state";
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
