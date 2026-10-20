import { emit, runOrExit } from "./lib/run";

export interface WorkflowRun {
  status: string;
  conclusion: string | null;
  displayTitle: string;
  createdAt: string;
  url?: string;
}

export interface CiStatus {
  state: "unknown" | "healthy" | "warning" | "error";
  detail: string;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

function age(createdAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(createdAt)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Map the newest CI run on main (from `gh run list --json`) to a status tile. */
export function ciStatus(runs: WorkflowRun[], now = new Date()): CiStatus {
  const latest = runs[0];
  if (!latest) return { state: "unknown", detail: "No CI runs on main yet." };
  const when = age(latest.createdAt, now);
  if (latest.status !== "completed") return { state: "warning", detail: `Running · ${latest.displayTitle} · ${when}` };
  if (latest.conclusion === "success") return { state: "healthy", detail: `Passed · ${latest.displayTitle} · ${when}` };
  if (latest.conclusion !== null && FAILED.has(latest.conclusion)) {
    return { state: "error", detail: `Failed · ${latest.displayTitle} · ${when}` };
  }
  return { state: "warning", detail: `${latest.conclusion ?? "Unknown"} · ${latest.displayTitle} · ${when}` };
}

if (import.meta.main) {
  const output = runOrExit([
    "gh", "run", "list", "--workflow", "CI", "--branch", "main", "--limit", "1",
    "--json", "status,conclusion,displayTitle,createdAt,url",
  ]);
  emit(ciStatus(JSON.parse(output) as WorkflowRun[]));
}
