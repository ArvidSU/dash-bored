import { describe, expect, test } from "bun:test";
import { actionVerb, isClosedState, stateTone } from "../../src/renderer/lib/state-visual";
import { trendDirection, trendSummary } from "../../src/renderer/lib/glance-visual";
import { diffObservedItems } from "../../src/renderer/lib/observation-changes";
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

  test("accepts bounded trend and part-of-whole segments on status", () => {
    expect(parseStatusValue({ state: "healthy", trend: [1, null, 3] })).toEqual({ state: "healthy", trend: [1, null, 3] });
    expect(parseStatusValue({ state: "warning", segments: [{ label: "Done", value: 2, state: "done" }, { label: "Open", value: 0 }] }))
      .toEqual({ state: "warning", segments: [{ label: "Done", value: 2, state: "done" }, { label: "Open", value: 0 }] });
    // Invalid glance data is a shape error, never silently dropped.
    expect(parseStatusValue({ state: "healthy", trend: [1] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", trend: [null, null] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", trend: Array.from({ length: 61 }, () => 1) })).toBeNull();
    expect(parseStatusValue({ state: "healthy", trend: [1, "2"] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", segments: [] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", segments: [{ label: "Done", value: -1 }] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", segments: [{ label: "", value: 1 }] })).toBeNull();
    expect(parseStatusValue({ state: "healthy", segments: [{ label: "Done", value: 1, state: 3 }] })).toBeNull();
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


test("visual state semantics retain unknowns and completed work", () => {
  expect(stateTone("HEALTHY")).toBe("positive");
  expect(stateTone("completed")).toBe("positive");
  expect(stateTone("running")).toBe("warning");
  expect(stateTone("failed")).toBe("negative");
  expect(stateTone("untracked")).toBe("neutral");
  expect(stateTone(undefined)).toBe("neutral");
  expect(stateTone("bug")).toBe("negative");
  expect(stateTone("Blocked")).toBe("warning");
  expect(stateTone("open")).toBe("neutral");
  expect(isClosedState("Closed")).toBe(true);
  expect(isClosedState("healthy")).toBe(false);
  expect(isClosedState(undefined, true)).toBe(true);
});

test("trend direction compares halves and states gaps", () => {
  expect(trendDirection([0, 0, 1, 5, 6])).toBe("rising");
  expect(trendDirection([6, 5, 1, 0])).toBe("falling");
  expect(trendDirection([2, 2, 2])).toBe("steady");
  expect(trendSummary([1, null, 3])).toBe("rising over 3 points; latest 3, low 1, high 3, 1 missing");
});

test("observed item changes key on stable IDs", () => {
  const changes = diffObservedItems(
    [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "gone", title: "Gone" }],
    [{ id: "a", title: "A" }, { id: "b", title: "B2" }, { id: "c", title: "C" }],
  );
  expect([...changes]).toEqual([["b", "changed"], ["c", "new"]]);
});

test("action verbs follow the action contract, with a neutral fallback", () => {
  expect(actionVerb("process:run-qa")).toBe("process");
  expect(actionVerb("agent:prompt")).toBe("agent");
  expect(actionVerb("select:sections/work")).toBe("navigate");
  expect(actionVerb("component:recent-commits:refresh")).toBe("refresh");
  expect(actionVerb("component:builtin-timer:start")).toBe("action");
  expect(actionVerb("app:settings")).toBe("action");
});
