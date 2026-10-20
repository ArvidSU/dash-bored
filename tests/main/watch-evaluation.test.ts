import { describe, expect, test } from "bun:test";
import {
  evaluateWatch,
  INITIAL_WATCH_MEMORY,
  type WatchDecision,
  type WatchMemory,
  type WatchObservation,
  type WatchSubject,
} from "../../src/main/watch-evaluation";

const CONFIG = "/p/.dash-bored/dash-bored.yaml";

function subject(overrides: Partial<WatchSubject> = {}): WatchSubject {
  return {
    configPath: CONFIG,
    dashboardName: "Project",
    nodeId: "ci",
    label: "CI",
    family: "status",
    on: ["error"],
    level: "interrupt",
    ...overrides,
  };
}

const ok = (value: unknown): WatchObservation => ({ ok: true, value });
const fail = (error: string): WatchObservation => ({ ok: false, error });

/** Feed observations in order; return every decision. */
function run(watch: WatchSubject, observations: WatchObservation[]): WatchDecision[] {
  let memory: WatchMemory = INITIAL_WATCH_MEMORY;
  return observations.map((observation) => {
    const decision = evaluateWatch(watch, memory, observation);
    memory = decision.memory;
    return decision;
  });
}

describe("status watch evaluation", () => {
  test("a baseline already in a watched state raises quietly", () => {
    const [baseline] = run(subject(), [ok({ state: "error", detail: "main is red" })]);
    expect(baseline!.raise).toEqual([{
      key: `watch:${CONFIG}:ci`,
      kind: "watch-state",
      level: "interrupt",
      configPath: CONFIG,
      dashboardName: "Project",
      title: "CI",
      message: "Error: main is red",
      target: { kind: "node", nodeId: "ci" },
      quiet: true,
    }]);
    expect(baseline!.memory).toEqual({ observed: true, state: "error", failing: false });
  });

  test("a healthy baseline records nothing and clears a stale entry", () => {
    const [baseline] = run(subject(), [ok({ state: "healthy" })]);
    expect(baseline!.raise).toEqual([]);
    expect(baseline!.resolve).toEqual([`watch:${CONFIG}:ci`]);
  });

  test("entering a watched state interrupts once; recovery resolves without an event", () => {
    const decisions = run(subject({ on: ["warning", "error"] }), [
      ok({ state: "healthy" }),
      ok({ state: "error", detail: "main is red" }),
      ok({ state: "error", detail: "still red" }),
      ok({ state: "warning" }),
      ok({ state: "healthy" }),
      ok({ state: "healthy" }),
    ]);
    expect(decisions.map((decision) => decision.raise.map((raise) => [raise.message, raise.quiet ?? false]))).toEqual([
      [],
      [["Error: main is red", false]],
      [],
      [["Warning", false]],
      [],
      [],
    ]);
    expect(decisions.map((decision) => decision.resolve)).toEqual([
      [`watch:${CONFIG}:ci`],
      [],
      [],
      [],
      [`watch:${CONFIG}:ci`],
      [],
    ]);
  });

  test("states outside `on` are not news", () => {
    const decisions = run(subject({ on: ["error"] }), [ok({ state: "healthy" }), ok({ state: "unknown" }), ok({ state: "warning" })]);
    expect(decisions.flatMap((decision) => decision.raise)).toEqual([]);
  });

  test("a failure informs once per streak and keeps the baseline", () => {
    const decisions = run(subject(), [
      fail("Command failed (exit 2): boom"),
      fail("Command failed (exit 2): boom"),
      ok({ state: "error" }),
      ok("not a status"),
      ok({ state: "healthy" }),
    ]);
    expect(decisions[0]!.raise).toEqual([expect.objectContaining({
      key: `watch-error:${CONFIG}:ci`,
      kind: "watch-error",
      level: "inform",
      message: "Watch failed: Command failed (exit 2): boom",
      target: { kind: "node", nodeId: "ci" },
    })]);
    expect(decisions[1]!.raise).toEqual([]);
    // The first success after failures is still the baseline, and it ends the streak.
    expect(decisions[2]!.raise).toEqual([expect.objectContaining({ kind: "watch-state", quiet: true })]);
    expect(decisions[2]!.resolve).toEqual([`watch-error:${CONFIG}:ci`]);
    // A shape mismatch is a failure that leaves the state alone.
    expect(decisions[3]!.raise).toEqual([expect.objectContaining({ kind: "watch-error", message: expect.stringContaining("not a status") })]);
    expect(decisions[3]!.memory).toEqual({ observed: true, state: "error", failing: true });
    expect(decisions[4]!.resolve).toEqual([`watch-error:${CONFIG}:ci`, `watch:${CONFIG}:ci`]);
  });

  test("level overrides and the declared action ride on the state entry", () => {
    const [, transition] = run(subject({
      level: "inform",
      action: { name: "Remediate with agent", run: "agent:prompt", with: { prompt: "Fix CI" } },
    }), [ok({ state: "healthy" }), ok({ state: "error" })]);
    expect(transition!.raise[0]).toMatchObject({
      level: "inform",
      message: "Error",
      action: { label: "Remediate with agent", invocation: { run: "agent:prompt", with: { prompt: "Fix CI" } } },
    });
  });
});

describe("list watch evaluation", () => {
  const list = subject({
    nodeId: "backlog",
    label: "Backlog",
    family: "list",
    on: ["added"],
    level: "inform",
    action: { name: "Show in backlog", run: "reveal:backlog", with: { item: "${item.id}", note: "${item.owner}" } },
  });
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Item ${id}`, ...extra });

  test("the baseline records items without events; new items raise, removed ones resolve", () => {
    const decisions = run(list, [
      ok([item("a"), item("b")]),
      ok([item("a"), item("b"), item("c", { detail: "needs triage", owner: "arvid" })]),
      ok([item("a"), item("c", { owner: "arvid" })]),
    ]);
    expect(decisions[0]!.raise).toEqual([]);
    expect(decisions[1]!.raise).toEqual([{
      key: `watch:${CONFIG}:backlog:item:c`,
      kind: "watch-item",
      level: "inform",
      configPath: CONFIG,
      dashboardName: "Project",
      title: "Backlog",
      message: "Item c — needs triage",
      target: { kind: "node", nodeId: "backlog", itemId: "c" },
      action: { label: "Show in backlog", invocation: { run: "reveal:backlog", with: { item: "c", note: "arvid" } } },
    }]);
    expect(decisions[2]!.raise).toEqual([]);
    expect(decisions[2]!.resolve).toEqual([`watch:${CONFIG}:backlog:item:b`]);
  });

  test("an item whose fields cannot fill the action still raises, without the action", () => {
    const [, added] = run(list, [ok([]), ok([item("x")])]);
    expect(added!.raise[0]!.action).toBeUndefined();
    expect(added!.raise[0]!.message).toBe("Item x");
  });

  test("more than five new items coalesce the rest into one entry", () => {
    const [, burst] = run(subject({ nodeId: "backlog", label: "Backlog", family: "list", on: ["added"], level: "inform" }), [
      ok([]),
      ok(["1", "2", "3", "4", "5", "6", "7"].map((id) => item(id))),
    ]);
    expect(burst!.raise.map((raise) => raise.key)).toEqual([
      ...["1", "2", "3", "4", "5"].map((id) => `watch:${CONFIG}:backlog:item:${id}`),
      `watch:${CONFIG}:backlog:more`,
    ]);
    expect(burst!.raise.at(-1)).toMatchObject({ message: "2 more new items", target: { kind: "node", nodeId: "backlog" } });
  });

  test("missing or duplicate IDs are shape errors that keep the baseline", () => {
    const decisions = run(list, [
      ok([item("a")]),
      ok([item("a"), item("a")]),
      ok([{ title: "No id" }]),
      ok([item("a"), item("b")]),
    ]);
    expect(decisions[1]!.raise).toEqual([expect.objectContaining({ kind: "watch-error", message: expect.stringContaining("duplicated") })]);
    expect(decisions[2]!.raise).toEqual([]);
    expect(decisions[3]!.raise.map((raise) => raise.key)).toEqual([`watch:${CONFIG}:backlog:item:b`]);
    expect(decisions[3]!.resolve).toEqual([`watch-error:${CONFIG}:backlog`]);
  });
});
