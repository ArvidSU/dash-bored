import { expect, test } from "bun:test";
import {
  addNotice,
  applySessionUpdate,
  createTranscriptState,
  MAX_CONFIG_CHOICES,
  MAX_CONFIG_OPTIONS,
  MAX_ENTRY_TEXT,
  MAX_LABEL_LENGTH,
  MAX_LOG_LINES,
  MAX_NOTICE_TEXT,
  MAX_PATH_LENGTH,
  MAX_PLAN_ENTRIES,
  MAX_TOOL_EDITS,
  MAX_TOOL_LOCATIONS,
  MAX_TOOL_OUTPUT,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_TRANSCRIPT_TEXT,
  pushLog,
  summarizeDiff,
} from "../../src/main/agent-session-updates";
import type { AgentSessionTask } from "../../src/shared/agent-session";

function task(): AgentSessionTask {
  return {
    id: "t", agent: { command: "x", name: "x" }, prompt: "p", componentPath: "c", request: "r", configPath: "/c", startedAt: "",
    state: "working", sessionId: "s", pid: 1, entries: [], truncated: 0, plan: null, permission: null, configOptions: [],
    turns: 0, handoff: null, dashboardChanged: false, log: [],
  };
}

const text = (value: string) => ({ type: "text" as const, text: value });

test("merges message chunks by message id, or by a run of chunks without one", () => {
  const current = task();
  const state = createTranscriptState();
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("Hel"), messageId: "m1" });
  applySessionUpdate(current, state, { sessionUpdate: "agent_thought_chunk", content: text("Thinking") });
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("lo"), messageId: "m1" });
  applySessionUpdate(current, state, { sessionUpdate: "agent_thought_chunk", content: text(" more") });
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("A") });
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("B") });
  applySessionUpdate(current, state, { sessionUpdate: "plan", entries: [] });
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("C") });
  applySessionUpdate(current, state, { sessionUpdate: "user_message_chunk", content: { type: "resource_link", name: "notes.md", uri: "file:///notes.md" } });
  expect(current.entries).toEqual([
    { kind: "agent", id: "m1", text: "Hello" },
    { kind: "thought", id: "thought-1", text: "Thinking" },
    { kind: "thought", id: "thought-2", text: " more" },
    { kind: "agent", id: "agent-3", text: "AB" },
    { kind: "agent", id: "agent-4", text: "C" },
    { kind: "user", id: "user-5", text: "[notes.md] file:///notes.md" },
  ]);
});

test("upserts tool calls and summarizes diffs as paths with line counts", () => {
  const current = task();
  const state = createTranscriptState();
  applySessionUpdate(current, state, {
    sessionUpdate: "tool_call", toolCallId: "c1", title: "Edit", kind: "edit",
    locations: [{ path: "/p/a.yaml", line: 3 }, { path: "/p/b.yaml", line: null }],
    content: [
      { type: "diff", path: "/p/a.yaml", oldText: "one\ntwo\nthree\n", newText: "one\n2\nthree\nfour\n" },
      { type: "diff", path: "/p/new.yaml", oldText: null, newText: "a\nb\n" },
      { type: "content", content: text("Applied.") },
    ],
  });
  applySessionUpdate(current, state, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
  applySessionUpdate(current, state, { sessionUpdate: "tool_call_update", toolCallId: "c2", title: "Late", kind: "execute" as never, status: "in_progress" });
  expect(current.entries).toEqual([
    {
      kind: "tool", id: "c1", title: "Edit", toolKind: "edit", status: "completed",
      locations: [{ path: "/p/a.yaml", line: 3 }, { path: "/p/b.yaml" }],
      edits: [{ path: "/p/a.yaml", added: 2, removed: 1 }, { path: "/p/new.yaml", added: 2, removed: 0 }],
      output: "Applied.",
    },
    { kind: "tool", id: "c2", title: "Late", toolKind: "execute", status: "in_progress", locations: [], edits: [] },
  ]);
  expect(JSON.stringify(current)).not.toContain("four");
  expect(summarizeDiff("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  expect(summarizeDiff(undefined, "")).toEqual({ added: 0, removed: 0 });
});

test("replaces the plan and config options, and keeps a mode fallback current", () => {
  const current = task();
  const state = createTranscriptState();
  applySessionUpdate(current, state, { sessionUpdate: "plan", entries: [{ content: "Do it", priority: "high", status: "pending" }] });
  applySessionUpdate(current, state, { sessionUpdate: "plan", entries: [{ content: "Done", priority: "low", status: "completed" }] });
  expect(current.plan).toEqual([{ content: "Done", priority: "low", status: "completed" }]);
  applySessionUpdate(current, state, {
    sessionUpdate: "config_option_update",
    configOptions: [
      { id: "model", name: "Model", type: "select", currentValue: "a", options: [{ group: "fast", name: "Fast", options: [{ value: "a", name: "A" }] }] },
      { id: "think", name: "Think", type: "boolean", currentValue: true, category: "thought_level" },
    ],
  });
  expect(current.configOptions).toEqual([
    { id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A", group: "Fast" }] },
    { id: "think", name: "Think", category: "thought_level", type: "boolean", currentValue: true },
  ]);
  state.modeFallback = true;
  current.configOptions = [{ id: "mode", name: "Mode", type: "select", currentValue: "ask", options: [] }];
  applySessionUpdate(current, state, { sessionUpdate: "current_mode_update", currentModeId: "code" });
  expect(current.configOptions[0]?.currentValue).toBe("code");
  applySessionUpdate(current, state, { sessionUpdate: "plan_removed", planId: "p" });
  expect(current.plan).toBeNull();
  // Kinds the app does not render are ignored.
  applySessionUpdate(current, state, { sessionUpdate: "available_commands_update", availableCommands: [] });
  applySessionUpdate(current, state, { sessionUpdate: "usage_update", used: 1, size: 2 });
});

test("bounds the transcript, entry text, tool output, and stderr tail", () => {
  const current = task();
  const state = createTranscriptState();
  for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES + 5; index += 1) {
    applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text(`m${index}`), messageId: `m${index}` });
  }
  expect(current.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
  expect(current.truncated).toBe(5);
  expect(current.entries[0]).toMatchObject({ id: "m5" });

  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("x".repeat(MAX_ENTRY_TEXT)), messageId: "big" });
  applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text("more"), messageId: "big" });
  const big = current.entries.at(-1)!;
  expect(big.kind === "agent" && big.text.length).toBe(MAX_ENTRY_TEXT);
  expect(big.kind === "agent" && big.text.endsWith("(truncated)")).toBeTrue();

  applySessionUpdate(current, state, { sessionUpdate: "tool_call", toolCallId: "t", title: "Run", content: [{ type: "content", content: text(`${"a".repeat(MAX_TOOL_OUTPUT)}END`) }] });
  const tool = current.entries.at(-1)!;
  expect(tool.kind === "tool" && tool.output?.length).toBe(MAX_TOOL_OUTPUT);
  expect(tool.kind === "tool" && tool.output?.endsWith("END")).toBeTrue();

  for (let index = 0; index < MAX_LOG_LINES + 3; index += 1) pushLog(current, `line ${index}`);
  expect(current.log).toHaveLength(MAX_LOG_LINES);
  expect(current.log[0]).toBe("line 3");
});

test("caps agent-supplied lists, paths, labels, and notices", () => {
  const current = task();
  const state = createTranscriptState();
  const long = `/work/${"p".repeat(MAX_PATH_LENGTH * 2)}`;
  applySessionUpdate(current, state, {
    sessionUpdate: "tool_call", toolCallId: "many", title: "Edit everything", kind: "edit",
    locations: Array.from({ length: MAX_TOOL_LOCATIONS + 10 }, (_, index) => ({ path: index === 0 ? long : `/work/${index}` })),
    content: Array.from({ length: MAX_TOOL_EDITS + 10 }, (_, index) => ({ type: "diff" as const, path: `/work/${index}`, oldText: "a", newText: "b" })),
  });
  const tool = current.entries.at(-1)!;
  if (tool.kind !== "tool") throw new Error("expected a tool entry");
  expect(tool.locations).toHaveLength(MAX_TOOL_LOCATIONS);
  expect(tool.locations[0]!.path).toHaveLength(MAX_PATH_LENGTH);
  expect(tool.locations[0]!.path.endsWith("…")).toBeTrue();
  expect(tool.edits).toHaveLength(MAX_TOOL_EDITS);

  applySessionUpdate(current, state, {
    sessionUpdate: "plan",
    entries: Array.from({ length: MAX_PLAN_ENTRIES + 5 }, (_, index) => ({ content: `step ${index}`, priority: "low" as const, status: "pending" as const })),
  });
  expect(current.plan).toHaveLength(MAX_PLAN_ENTRIES);

  applySessionUpdate(current, state, {
    sessionUpdate: "config_option_update",
    configOptions: Array.from({ length: MAX_CONFIG_OPTIONS + 5 }, (_, index) => ({
      id: `option-${index}`, name: "n".repeat(MAX_LABEL_LENGTH * 2), type: "select" as const, currentValue: "v0",
      options: Array.from({ length: MAX_CONFIG_CHOICES + 5 }, (_, choice) => ({ value: `v${choice}`, name: `Choice ${choice}` })),
    })),
  });
  expect(current.configOptions).toHaveLength(MAX_CONFIG_OPTIONS);
  expect(current.configOptions[0]!.name).toHaveLength(MAX_LABEL_LENGTH);
  expect(current.configOptions[0]!.options).toHaveLength(MAX_CONFIG_CHOICES);

  addNotice(current, state, "error", "e".repeat(MAX_NOTICE_TEXT * 2));
  const notice = current.entries.at(-1)!;
  expect(notice.kind === "notice" && notice.text.length).toBe(MAX_NOTICE_TEXT);
});

test("bounds the total transcript text by dropping the oldest entries", () => {
  const current = task();
  const state = createTranscriptState();
  const chunk = "x".repeat(MAX_ENTRY_TEXT - 100);
  const count = Math.ceil(MAX_TRANSCRIPT_TEXT / chunk.length) + 3;
  for (let index = 0; index < count; index += 1) {
    applySessionUpdate(current, state, { sessionUpdate: "agent_message_chunk", content: text(chunk), messageId: `big-${index}` });
  }
  const size = current.entries.reduce((total, entry) => total + (entry.kind === "tool" ? 0 : entry.text.length), 0);
  expect(size).toBeLessThanOrEqual(MAX_TRANSCRIPT_TEXT);
  expect(current.truncated).toBe(count - current.entries.length);
  expect(current.truncated).toBeGreaterThanOrEqual(3);
  expect(current.entries.at(-1)).toMatchObject({ id: `big-${count - 1}` });

  // Tool output counts too; the newest entry always stays.
  applySessionUpdate(current, state, { sessionUpdate: "tool_call", toolCallId: "out", title: "Run", content: [{ type: "content", content: text("o".repeat(MAX_TOOL_OUTPUT)) }] });
  expect(current.entries.at(-1)).toMatchObject({ kind: "tool", id: "out" });
  expect(current.entries.reduce((total, entry) => total + (entry.kind === "tool" ? (entry.output?.length ?? 0) + entry.title.length : entry.text.length), 0)).toBeLessThanOrEqual(MAX_TRANSCRIPT_TEXT);
});
