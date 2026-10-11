import { describe, expect, test } from "bun:test";
import type { AgentCommandOptions, AgentSessionState, AgentSessionTask } from "../../src/shared/agent-session";
import {
  AGENT_TASK_LIMIT,
  agentDisplayPath,
  agentEditSummary,
  agentLocationLabel,
  agentStateNeedsUser,
  agentTaskSummary,
  boundAgentTasks,
  busyAgentTaskCount,
  isAgentStateActive,
  isAgentTaskPinned,
  replaceAgentTask,
  sortAgentTasks,
  waitingAgentTaskCount,
} from "../../src/renderer/lib/agent-tasks";
import {
  choiceForPickerValue,
  commandForPickerValue,
  effectivePickerValue,
  pickerValueForChoice,
  settingsPickerValue,
} from "../../src/renderer/lib/agent-options";

const states = (...list: AgentSessionState[]) => list.map((state) => ({ state }));

describe("agent task presentation", () => {
  test("counts busy and user-blocked sessions", () => {
    const tasks = states("starting", "working", "waiting", "auth-required", "idle", "closed", "failed");
    expect(busyAgentTaskCount(tasks)).toBe(3);
    expect(waitingAgentTaskCount(tasks)).toBe(2);
    expect(tasks.filter((task) => agentStateNeedsUser(task.state)).map((task) => task.state)).toEqual(["waiting", "auth-required"]);
    expect(tasks.filter((task) => isAgentStateActive(task.state)).map((task) => task.state))
      .toEqual(["starting", "working", "waiting", "auth-required"]);
    expect(isAgentStateActive(undefined)).toBeFalse();
  });

  test("summarizes the first sentence within bounds", () => {
    expect(agentTaskSummary({ request: "  Add a chart.   Then   tidy up. " })).toBe("Add a chart.");
    expect(agentTaskSummary({ request: "" })).toBe("Agent request");
    const long = agentTaskSummary({ request: "x".repeat(400) });
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBeTrue();
  });

  test("shows touched paths relative to the owning project", () => {
    const config = "/work/app/.dash-bored/dash-bored.yaml";
    expect(agentDisplayPath("/work/app/src/a.ts", config)).toBe("src/a.ts");
    expect(agentDisplayPath("/elsewhere/a.ts", config)).toBe("/elsewhere/a.ts");
    expect(agentEditSummary({ path: "/work/app/.dash-bored/dash-bored.yaml", added: 4, removed: 1 }, config))
      .toBe(".dash-bored/dash-bored.yaml +4 −1");
    expect(agentLocationLabel({ path: "/work/app/README.md", line: 12 }, config)).toBe("README.md:12");
  });

  test("replaces a task update in place, newest first", () => {
    const task = (id: string, startedAt: string, state: AgentSessionState) => ({ id, startedAt, state }) as AgentSessionTask;
    const tasks = [task("b", "2026-01-02T00:00:00Z", "working"), task("a", "2026-01-01T00:00:00Z", "idle")];
    const next = replaceAgentTask(tasks, task("a", "2026-01-01T00:00:00Z", "closed"));
    expect(next.map((entry) => [entry.id, entry.state])).toEqual([["b", "working"], ["a", "closed"]]);
  });

  describe("task list bound", () => {
    type Validation = NonNullable<AgentSessionTask["validation"]>["status"];
    // Index 0 is the oldest; ids sort by start time.
    const task = (index: number, state: AgentSessionState, validation?: Validation) => ({
      id: `t${String(index).padStart(2, "0")}`,
      startedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      state,
      ...(validation ? { validation: { status: validation, diagnostics: [] } } : {}),
    }) as AgentSessionTask;
    const ids = (tasks: readonly AgentSessionTask[]) => tasks.map((entry) => entry.id);
    const fill = (count: number, state: AgentSessionState, from = 0) =>
      Array.from({ length: count }, (_, offset) => task(from + offset, state));

    test("keeps the 20 most recent sessions", () => {
      const next = fill(20, "idle").reduce(replaceAgentTask, [] as AgentSessionTask[]);
      expect(next).toHaveLength(AGENT_TASK_LIMIT);
      const after = replaceAgentTask(next, task(20, "idle"));
      expect(after).toHaveLength(20);
      expect(after[0]!.id).toBe("t20");
      expect(ids(after)).not.toContain("t00");
    });

    test("drops closed and failed sessions before older idle ones", () => {
      const tasks = sortAgentTasks([...fill(18, "idle"), task(18, "closed"), task(19, "failed")]);
      const next = replaceAgentTask(tasks, task(20, "idle"));
      expect(next).toHaveLength(20);
      expect(ids(next)).toContain("t00");
      expect(ids(next)).toContain("t19");
      expect(ids(next)).not.toContain("t18");
      const trimmed = boundAgentTasks(sortAgentTasks([...tasks, task(20, "idle"), task(21, "idle")]));
      expect(ids(trimmed)).not.toContain("t18");
      expect(ids(trimmed)).not.toContain("t19");
      expect(ids(trimmed)).toContain("t00");
    });

    test("never drops live, user-blocked, or validating sessions", () => {
      const pinned = [
        task(0, "starting"),
        task(1, "auth-required"),
        task(2, "working"),
        task(3, "waiting"),
        task(4, "idle", "checking"),
        task(5, "closed", "repairing"),
      ];
      const tasks = sortAgentTasks([...pinned, ...fill(16, "closed", 6)]);
      const next = boundAgentTasks(tasks);
      expect(next).toHaveLength(20);
      for (const entry of pinned) expect(ids(next)).toContain(entry.id);
      expect(ids(next)).not.toContain("t06");
      expect(ids(next)).not.toContain("t07");
      // More pinned sessions than the bound: all stay.
      const busy = sortAgentTasks(fill(22, "working"));
      expect(boundAgentTasks(busy)).toHaveLength(22);
      expect(isAgentTaskPinned(task(0, "idle", "valid"))).toBeFalse();
    });
  });
});

describe("agent picker options", () => {
  const options: AgentCommandOptions = {
    app: "claude-code-acp",
    project: "codex-acp --model x",
    detected: [
      { id: "claude", name: "Claude Code", command: "claude-code-acp", resumable: true },
      { id: "gemini", name: "Gemini CLI", command: "gemini --experimental-acp", resumable: false },
    ],
    known: [
      { id: "claude", name: "Claude Code", command: "claude-code-acp", homepage: "https://example.com/claude" },
      { id: "gemini", name: "Gemini CLI", command: "gemini --experimental-acp", homepage: "https://example.com/gemini" },
      { id: "codex", name: "Codex", command: "codex-acp", homepage: "https://example.com/codex" },
    ],
    effective: { source: "detected", command: "gemini --experimental-acp", name: "Gemini CLI" },
  };

  test("maps picker values to choices and back", () => {
    expect(choiceForPickerValue("detected:gemini", "")).toEqual({ source: "detected", id: "gemini" });
    expect(choiceForPickerValue("custom", "  my-agent --acp ")).toEqual({ source: "custom", command: "my-agent --acp" });
    expect(choiceForPickerValue("project", "ignored")).toEqual({ source: "project" });
    expect(pickerValueForChoice({ source: "detected", id: "claude" })).toBe("detected:claude");
    expect(pickerValueForChoice({ source: "custom", command: "x" })).toBe("custom");
  });

  test("shows the exact command each value runs", () => {
    expect(effectivePickerValue(options)).toBe("detected:gemini");
    expect(effectivePickerValue({ ...options, effective: null })).toBeNull();
    expect(commandForPickerValue("app", options, "")).toBe("claude-code-acp");
    expect(commandForPickerValue("project", options, "")).toBe("codex-acp --model x");
    expect(commandForPickerValue("project", { ...options, project: null }, "")).toBe("");
    expect(commandForPickerValue("detected:gemini", options, "")).toBe("gemini --experimental-acp");
    expect(commandForPickerValue("custom", options, " mine ")).toBe("mine");
  });

  test("maps the Settings command string onto the picker", () => {
    expect(settingsPickerValue(null, options)).toBe("bundle");
    expect(settingsPickerValue(" gemini --experimental-acp ", options)).toBe("detected:gemini");
    expect(settingsPickerValue("other-agent", options)).toBe("custom");
  });
});
