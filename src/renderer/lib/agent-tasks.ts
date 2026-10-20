import type {
  AgentSessionEntry,
  AgentSessionState,
  AgentSessionTask,
} from "../../shared/agent-session";
import { isAgentTaskBusy } from "../../shared/agent-session";

/*
 * Presentation rules for agent sessions, shared by the Agent work drawer, its
 * task modal, and the host session that decides when the drawer opens.
 */

export const AGENT_STATE_LABELS: Readonly<Record<AgentSessionState, string>> = {
  starting: "Starting",
  "auth-required": "Sign-in required",
  working: "Working",
  waiting: "Needs permission",
  idle: "Idle",
  closed: "Closed",
  failed: "Failed",
};

/** Signal color family per state; the chip also carries a distinct glyph and text. */
export type AgentStateTone = "progress" | "attention" | "ready" | "quiet" | "negative";

export function agentStateTone(state: AgentSessionState): AgentStateTone {
  switch (state) {
    case "starting":
    case "working": return "progress";
    case "waiting":
    case "auth-required": return "attention";
    case "idle": return "ready";
    case "failed": return "negative";
    default: return "quiet";
  }
}

/** States with a live turn or launch; only these animate. */
export function isAgentStateInProgress(state: AgentSessionState): boolean {
  return state === "starting" || state === "working";
}

/** The agent is blocked on the user: the drawer opens even after a dismissal. */
export function agentStateNeedsUser(state: AgentSessionState): boolean {
  return state === "waiting" || state === "auth-required";
}

/** Becoming one of these from any other state is an activation that opens the drawer. */
export function isAgentStateActive(state: AgentSessionState | undefined): boolean {
  return state === "starting" || state === "working" || state === "waiting" || state === "auth-required";
}

/** The header badge counts sessions that are working or waiting on the user (permission or sign-in). */
export function busyAgentTaskCount(tasks: readonly Pick<AgentSessionTask, "state">[]): number {
  return tasks.filter((task) => task.state === "working" || agentStateNeedsUser(task.state)).length;
}

export function waitingAgentTaskCount(tasks: readonly Pick<AgentSessionTask, "state">[]): number {
  return tasks.filter((task) => agentStateNeedsUser(task.state)).length;
}

/** The session accepts commands that need a live agent connection. */
export function isAgentSessionOpen(state: AgentSessionState): boolean {
  return state === "idle" || state === "working" || state === "waiting";
}

export { agentTaskSummary } from "../../shared/agent-session";

export function agentTaskStartedTime(task: Pick<AgentSessionTask, "startedAt">): string | null {
  if (!task.startedAt) return null;
  const date = new Date(task.startedAt);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type AgentValidationTone = "progress" | "positive" | "negative" | "attention" | "quiet";

export function agentValidationLabel(task: Pick<AgentSessionTask, "validation">): string | null {
  switch (task.validation?.status) {
    case "checking": return "Checking dashboard";
    case "repairing": return "Repairing dashboard";
    case "valid": return "Dashboard validated";
    case "failed": return "Dashboard needs attention";
    case "trust-required": return "Review project trust";
    case "cancelled": return "Follow-up cancelled";
    default: return null;
  }
}

export function agentValidationTone(task: Pick<AgentSessionTask, "validation">): AgentValidationTone {
  switch (task.validation?.status) {
    case "checking":
    case "repairing": return "progress";
    case "valid": return "positive";
    case "failed": return "negative";
    case "trust-required": return "attention";
    default: return "quiet";
  }
}

/** The app the session continues in after hand-off. */
export function agentHandoffApp(task: Pick<AgentSessionTask, "handoff" | "agent">): string {
  return task.handoff?.app.trim() || task.agent.name;
}

/** Main keeps at most this many sessions; the renderer mirrors the bound. */
export const AGENT_TASK_LIMIT = 20;

/** A live launch or turn, a pending user decision, or a running dashboard follow-up: never pruned. */
export function isAgentTaskPinned(task: Pick<AgentSessionTask, "state" | "validation">): boolean {
  // The main process prunes by the same predicate, so both lists agree.
  return isAgentTaskBusy(task);
}

/**
 * Trims a newest-first list to `limit` sessions: the oldest closed or failed
 * sessions go first, then the oldest idle ones. Pinned sessions always stay,
 * even when that leaves the list above the limit.
 */
export function boundAgentTasks<T extends Pick<AgentSessionTask, "state" | "validation">>(
  tasks: readonly T[],
  limit = AGENT_TASK_LIMIT,
): T[] {
  let excess = tasks.length - limit;
  if (excess <= 0) return [...tasks];
  const dropped = new Set<T>();
  const dropOldest = (eligible: (task: T) => boolean): void => {
    for (let index = tasks.length - 1; index >= 0 && excess > 0; index -= 1) {
      const task = tasks[index];
      if (!task || dropped.has(task) || isAgentTaskPinned(task) || !eligible(task)) continue;
      dropped.add(task);
      excess -= 1;
    }
  };
  dropOldest((task) => task.state === "closed" || task.state === "failed");
  dropOldest(() => true);
  return tasks.filter((task) => !dropped.has(task));
}

/** Newest first, bounded; a task update replaces its previous copy. */
export function replaceAgentTask(tasks: readonly AgentSessionTask[], next: AgentSessionTask): AgentSessionTask[] {
  return boundAgentTasks(sortAgentTasks([next, ...tasks.filter((task) => task.id !== next.id)]));
}

export function sortAgentTasks<T extends Pick<AgentSessionTask, "startedAt">>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export type AgentToolEntry = Extract<AgentSessionEntry, { kind: "tool" }>;

export const AGENT_TOOL_STATUS_LABELS: Readonly<Record<AgentToolEntry["status"], string>> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

export const AGENT_TOOL_KIND_LABELS: Readonly<Record<AgentToolEntry["toolKind"], string>> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Mode",
  other: "Tool",
};

/**
 * A touched path relative to the owning project when it lies inside it. The
 * project root is the directory that holds the task's `.dash-bored` bundle.
 */
export function agentDisplayPath(path: string, configPath: string): string {
  const bundle = configPath.lastIndexOf("/.dash-bored/");
  if (bundle <= 0) return path;
  const root = configPath.slice(0, bundle + 1);
  return path.startsWith(root) && path.length > root.length ? path.slice(root.length) : path;
}

/** `path +N −M`, the app's whole representation of an edit. */
export function agentEditSummary(edit: { path: string; added: number; removed: number }, configPath = ""): string {
  return `${agentDisplayPath(edit.path, configPath)} +${edit.added} −${edit.removed}`;
}

export function agentLocationLabel(location: { path: string; line?: number }, configPath = ""): string {
  const path = agentDisplayPath(location.path, configPath);
  return location.line === undefined ? path : `${path}:${location.line}`;
}

/** Plan progress as "N of M done". */
export function agentPlanProgress(plan: readonly { status: string }[]): string {
  const done = plan.filter((entry) => entry.status === "completed").length;
  return `${done} of ${plan.length} done`;
}
