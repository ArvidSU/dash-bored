import type { ProcessRunSnapshot, ProcessSnapshot } from "./contracts";

/**
 * Latest run of a process resource's command. Snapshots from older producers
 * (or fixtures) without `run` describe a non-interactive process whose
 * lifetime is the run.
 */
export function processRun(snapshot: ProcessSnapshot | undefined): ProcessRunSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  // Status sources may hand over arbitrary JSON, so read fields defensively.
  const run = normalizedRun(snapshot.run);
  if (run !== undefined) return run;
  if (snapshot.interactive === true) return undefined;
  return normalizedRun(snapshot);
}

function normalizedRun(value: unknown): ProcessRunSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (phase !== "running" && phase !== "stopping" && phase !== "exited" && phase !== "failed") return undefined;
  return {
    phase,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    signal: typeof record.signal === "string" ? record.signal : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
  };
}

/** The command itself is executing (a second run would be a duplicate). */
export function isProcessRunActive(snapshot: ProcessSnapshot | undefined): boolean {
  const phase = processRun(snapshot)?.phase;
  return phase === "running" || phase === "stopping";
}

/** The supervised process, or the interactive terminal around its runs, is alive. */
export function isProcessLive(snapshot: ProcessSnapshot | undefined): boolean {
  return snapshot?.phase === "running" || snapshot?.phase === "stopping";
}

/** A short run outcome such as "exit 0", "exit 2", or "SIGINT". */
export function processRunOutcome(run: ProcessRunSnapshot): string {
  if (run.phase === "running") return "running";
  if (run.phase === "stopping") return "stopping";
  if (run.signal !== null) return run.signal;
  if (run.exitCode !== null) return `exit ${run.exitCode}`;
  return run.phase === "failed" ? "failed to start" : "exited";
}

/** A finished run that did not exit cleanly with code 0. */
export function processRunFailed(run: ProcessRunSnapshot): boolean {
  return (run.phase === "exited" || run.phase === "failed") && !(run.exitCode === 0 && run.signal === null);
}
