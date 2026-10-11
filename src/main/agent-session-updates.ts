import type {
  ContentBlock,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AgentConfigOption,
  AgentLocation,
  AgentPlanEntry,
  AgentSessionEntry,
  AgentSessionTask,
  AgentToolKind,
} from "../shared/agent-session";

/*
 * Reduction of ACP session updates into the bounded task projection the
 * renderer shows. Pure functions over the task; the session manager owns
 * when they run.
 */

export const MAX_TRANSCRIPT_ENTRIES = 400;
/** All transcript text together (UTF-16 code units); the oldest entries go first. */
export const MAX_TRANSCRIPT_TEXT = 1024 * 1024;
export const MAX_ENTRY_TEXT = 64 * 1024;
export const MAX_TOOL_OUTPUT = 8 * 1024;
export const MAX_LOG_LINES = 200;
/** Notices and error messages, which may quote the agent. */
export const MAX_NOTICE_TEXT = 4 * 1024;
export const MAX_PATH_LENGTH = 1024;
/** Display names and descriptions the agent supplies. */
export const MAX_LABEL_LENGTH = 1024;
export const MAX_TOOL_LOCATIONS = 50;
export const MAX_TOOL_EDITS = 50;
export const MAX_PLAN_ENTRIES = 100;
export const MAX_CONFIG_OPTIONS = 20;
export const MAX_CONFIG_CHOICES = 200;
export const MAX_PERMISSION_OPTIONS = 10;
export const MAX_AUTH_METHODS = 10;
/** The mode select synthesized from legacy `modes` when an agent sends no config options. */
export const MODE_FALLBACK_ID = "mode";

const TRUNCATED = "\n\n… (truncated)";
const TOOL_KINDS = new Set<AgentToolKind>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

type MessageKind = "user" | "agent" | "thought";

/** Transcript bookkeeping that is not part of the published task. */
export interface TranscriptState {
  /** The entry that chunks without a message id extend until any other update arrives. */
  run: { kind: MessageKind; id: string } | null;
  nextId: number;
  /** The agent sent no config options; `modes` is shown as a `mode` select. */
  modeFallback: boolean;
}

export function createTranscriptState(): TranscriptState {
  return { run: null, nextId: 1, modeFallback: false };
}

export function boundText(text: string, limit = MAX_ENTRY_TEXT): string {
  return text.length > limit ? `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}` : text;
}

/** A path or label cut to `limit`; a cut value ends in `…` and is exactly `limit` long. */
export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Keep the end of tool output, where command failures usually are. */
export function boundOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `…${text.slice(text.length - MAX_TOOL_OUTPUT + 1)}` : text;
}

export function pushLog(task: AgentSessionTask, line: string): void {
  task.log.push(line);
  if (task.log.length > MAX_LOG_LINES) task.log.splice(0, task.log.length - MAX_LOG_LINES);
}

function entrySize(entry: AgentSessionEntry): number {
  if (entry.kind !== "tool") return entry.text.length;
  let size = entry.title.length + (entry.output?.length ?? 0);
  for (const location of entry.locations) size += location.path.length;
  for (const edit of entry.edits) size += edit.path.length;
  return size;
}

/**
 * Drop the oldest entries beyond the entry count or total text bound, so every
 * emission stays small. The newest entry is always kept.
 */
export function boundTranscript(task: AgentSessionTask): void {
  const excess = task.entries.length - MAX_TRANSCRIPT_ENTRIES;
  let size = 0;
  for (const entry of task.entries) size += entrySize(entry);
  let drop = 0;
  while (drop < task.entries.length - 1 && (drop < excess || size > MAX_TRANSCRIPT_TEXT)) {
    size -= entrySize(task.entries[drop]!);
    drop += 1;
  }
  if (drop > 0) {
    task.entries.splice(0, drop);
    task.truncated += drop;
  }
}

export function addEntry(task: AgentSessionTask, entry: AgentSessionEntry): void {
  task.entries.push(entry);
  boundTranscript(task);
}

export function addNotice(task: AgentSessionTask, state: TranscriptState, level: "info" | "warning" | "error", text: string): void {
  addEntry(task, { kind: "notice", id: `notice-${state.nextId++}`, level, text: boundText(text, MAX_NOTICE_TEXT) });
}

/** Text the transcript can show for one content block; binary content is named, not embedded. */
export function contentText(block: ContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "image": return "[image]";
    case "audio": return "[audio]";
    case "resource_link": return block.title || block.name ? `[${block.title || block.name}] ${block.uri}` : block.uri;
    case "resource": return "text" in block.resource ? block.resource.text : `[resource] ${block.resource.uri}`;
    default: return "";
  }
}

/** Merge a chunk by message id, or into the consecutive run of the same kind when there is none. */
export function appendChunk(task: AgentSessionTask, state: TranscriptState, kind: MessageKind, text: string, messageId?: string | null): void {
  if (text === "") return;
  const id = messageId || (state.run?.kind === kind ? state.run.id : null);
  let target: AgentSessionEntry | undefined;
  if (id) {
    for (let index = task.entries.length - 1; index >= 0; index -= 1) {
      const entry = task.entries[index]!;
      if (entry.kind === kind && entry.id === id) { target = entry; break; }
    }
  }
  let entryId: string;
  if (target && (target.kind === "user" || target.kind === "agent" || target.kind === "thought")) {
    if (!target.text.endsWith(TRUNCATED)) target.text = boundText(target.text + text);
    entryId = target.id;
    boundTranscript(task);
  } else {
    entryId = id ?? `${kind}-${state.nextId++}`;
    addEntry(task, { kind, id: entryId, text: boundText(text) });
  }
  state.run = messageId ? null : { kind, id: entryId };
}

/** Line-count summary of one ACP diff. The diff text itself is never kept. */
export function summarizeDiff(oldText: string | null | undefined, newText: string): { added: number; removed: number } {
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const before = lines(oldText ?? "");
  const after = lines(newText);
  // Multiset difference: moved lines count as unchanged, which is good enough for a +/- summary.
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added += 1;
  }
  let removed = 0;
  for (const remaining of counts.values()) removed += remaining;
  return { added, removed };
}

function locations(items: readonly ToolCallLocation[] | null | undefined): AgentLocation[] {
  return (items ?? []).slice(0, MAX_TOOL_LOCATIONS).map((item) => {
    const path = clip(item.path, MAX_PATH_LENGTH);
    return typeof item.line === "number" ? { path, line: item.line } : { path };
  });
}

function toolKind(kind: string | null | undefined): AgentToolKind {
  return kind && TOOL_KINDS.has(kind as AgentToolKind) ? (kind as AgentToolKind) : "other";
}

function toolContent(content: readonly ToolCallContent[]): { edits: Array<{ path: string; added: number; removed: number }>; output?: string } {
  const edits: Array<{ path: string; added: number; removed: number }> = [];
  const text: string[] = [];
  for (const item of content) {
    if (item.type === "diff") {
      const path = clip(item.path, MAX_PATH_LENGTH);
      const existing = edits.find((edit) => edit.path === path);
      if (!existing && edits.length >= MAX_TOOL_EDITS) continue;
      const summary = summarizeDiff(item.oldText, item.newText);
      if (existing) {
        existing.added += summary.added;
        existing.removed += summary.removed;
      } else {
        edits.push({ path, ...summary });
      }
    } else if (item.type === "content") {
      const value = contentText(item.content);
      if (value) text.push(value);
    }
    // Terminal content needs the terminal capability, which the app does not offer.
  }
  return { edits, ...(text.length > 0 ? { output: boundOutput(text.join("\n")) } : {}) };
}

/** Insert or update a tool call from `tool_call`, `tool_call_update`, or a permission request. */
export function upsertTool(task: AgentSessionTask, update: ToolCallUpdate & { title?: string | null }): Extract<AgentSessionEntry, { kind: "tool" }> {
  let entry = task.entries.find((candidate): candidate is Extract<AgentSessionEntry, { kind: "tool" }> =>
    candidate.kind === "tool" && candidate.id === update.toolCallId);
  if (!entry) {
    entry = { kind: "tool", id: update.toolCallId, title: "Tool call", toolKind: "other", status: "pending", locations: [], edits: [] };
    addEntry(task, entry);
  }
  if (update.title) entry.title = boundText(update.title, 2_000);
  if (update.kind) entry.toolKind = toolKind(update.kind);
  if (update.status && TOOL_STATUSES.has(update.status)) entry.status = update.status;
  if (update.locations) entry.locations = locations(update.locations);
  if (update.content) {
    const { edits, output } = toolContent(update.content);
    entry.edits = edits;
    if (output === undefined) delete entry.output;
    else entry.output = output;
  }
  boundTranscript(task);
  return entry;
}

export function planEntries(entries: ReadonlyArray<{ content: string; priority: string; status: string }>): AgentPlanEntry[] {
  return entries.slice(0, MAX_PLAN_ENTRIES).map((entry) => ({
    content: boundText(entry.content, 4_000),
    priority: entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium",
    status: entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending",
  }));
}

const label = (text: string) => clip(text, MAX_LABEL_LENGTH);
const described = (description: string | null | undefined) => (description ? { description: label(description) } : {});

export function configOptions(options: readonly SessionConfigOption[]): AgentConfigOption[] {
  return options.slice(0, MAX_CONFIG_OPTIONS).map((option): AgentConfigOption => {
    const base = {
      id: option.id,
      name: label(option.name),
      ...described(option.description),
      ...(option.category ? { category: clip(option.category, MAX_LABEL_LENGTH) } : {}),
    };
    if (option.type === "boolean") return { ...base, type: "boolean", currentValue: option.currentValue };
    const choices = option.options.flatMap((item) => ("group" in item
      ? item.options.map((choice) => ({ value: choice.value, name: label(choice.name), ...described(choice.description), group: label(item.name) }))
      : [{ value: item.value, name: label(item.name), ...described(item.description) }]));
    return { ...base, type: "select", currentValue: option.currentValue, options: choices.slice(0, MAX_CONFIG_CHOICES) };
  });
}

/** The legacy session modes, shown as one `mode` select. */
export function modeOption(modes: SessionModeState): AgentConfigOption {
  return {
    id: MODE_FALLBACK_ID,
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: modes.currentModeId,
    options: modes.availableModes.slice(0, MAX_CONFIG_CHOICES).map((mode) => ({ value: mode.id, name: label(mode.name), ...described(mode.description) })),
  };
}

/** Apply one `session/update`. Unknown kinds are ignored so newer agents keep working. */
export function applySessionUpdate(task: AgentSessionTask, state: TranscriptState, update: SessionUpdate): void {
  const chunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk"
    || update.sessionUpdate === "agent_thought_chunk";
  // Any other update ends a run of chunks without message ids.
  if (!chunk) state.run = null;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      appendChunk(task, state, "user", contentText(update.content), update.messageId);
      return;
    case "agent_message_chunk":
      appendChunk(task, state, "agent", contentText(update.content), update.messageId);
      return;
    case "agent_thought_chunk":
      appendChunk(task, state, "thought", contentText(update.content), update.messageId);
      return;
    case "tool_call":
      upsertTool(task, { ...update, kind: update.kind ?? "other", status: update.status ?? "pending" });
      return;
    case "tool_call_update":
      upsertTool(task, update);
      return;
    case "plan":
      task.plan = planEntries(update.entries);
      return;
    case "plan_update":
      if (update.plan.type === "items") task.plan = planEntries(update.plan.entries);
      return;
    case "plan_removed":
      task.plan = null;
      return;
    case "config_option_update":
      state.modeFallback = false;
      task.configOptions = configOptions(update.configOptions);
      return;
    case "current_mode_update":
      if (state.modeFallback) {
        const option = task.configOptions.find((candidate) => candidate.id === MODE_FALLBACK_ID);
        if (option) option.currentValue = update.currentModeId;
      }
      return;
    case "notice": {
      const level = update.severity === "warning" || update.severity === "error" ? update.severity : "info";
      addNotice(task, state, level, update.description ? `${update.title}\n${update.description}` : update.title);
      return;
    }
    default:
      return;
  }
}
