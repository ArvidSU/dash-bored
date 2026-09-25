import { describe, expect, test } from "bun:test";
import { parseSourceChart, parseStatusValue } from "../../src/renderer/lib/view-shapes";

describe("source-bound view shapes", () => {
  test("accepts status models and derives process outcomes", () => {
    expect(parseStatusValue({ state: "healthy", detail: "Ready" })).toEqual({ state: "healthy", detail: "Ready" });
    expect(parseStatusValue({ phase: "running", exitCode: null })).toMatchObject({ state: "warning" });
    expect(parseStatusValue({ phase: "exited", exitCode: 0 })).toMatchObject({ state: "healthy" });
    expect(parseStatusValue({ phase: "failed", exitCode: 1 })).toMatchObject({ state: "error" });
    expect(parseStatusValue({ phase: "idle", exitCode: null })).toMatchObject({ state: "unknown" });
    expect(parseStatusValue({ ready: true })).toBeNull();
    expect(parseStatusValue({ state: "healthy", detail: 1 })).toBeNull();
  });

  test("observes the latest run of an interactive terminal, not the open terminal", () => {
    const terminal = { id: "run-qa", phase: "running", interactive: true, pid: 42, exitCode: null, signal: null, logs: [] };
    const run = { startedAt: "2026-09-24T10:00:00.000Z", signal: null };
    expect(parseStatusValue(terminal)).toEqual({ state: "unknown", detail: "Terminal open; not run yet" });
    expect(parseStatusValue({ ...terminal, run: { ...run, phase: "running", exitCode: null } }))
      .toEqual({ state: "warning", detail: "Running" });
    expect(parseStatusValue({ ...terminal, run: { ...run, phase: "exited", exitCode: 0, durationMs: 5 } }))
      .toEqual({ state: "healthy", detail: "Exit code 0" });
    expect(parseStatusValue({ ...terminal, run: { ...run, phase: "exited", exitCode: 2, durationMs: 5 } }))
      .toEqual({ state: "error", detail: "Exit code 2" });
    expect(parseStatusValue({ ...terminal, run: { ...run, phase: "exited", exitCode: null, signal: "SIGINT" } }))
      .toEqual({ state: "error", detail: "Stopped by SIGINT" });
    // A closed terminal keeps reporting its last run.
    expect(parseStatusValue({ ...terminal, phase: "exited", exitCode: 0, run: { ...run, phase: "exited", exitCode: 1 } }))
      .toMatchObject({ state: "error", detail: "Exit code 1" });
  });

  test("requires the documented chart source shape", () => {
    expect(parseSourceChart({ labels: ["A", "B"], series: [{ label: "Builds", values: [1, null] }] }))
      .toEqual({ labels: ["A", "B"], series: [{ label: "Builds", values: [1, null] }] });
    expect(parseSourceChart({ values: [1, 2] })).toBeNull();
    expect(parseSourceChart({ labels: ["A"], series: [{ label: "Broken", values: ["1"] }] })).toBeNull();
  });
});
