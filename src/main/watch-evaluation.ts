import type { NodeWatch, NodeWatchEvent } from "../shared/contracts";
import type { NotificationAction, NotificationLevel } from "../shared/notifications";
import {
  parseWatchList,
  parseWatchStatus,
  resolveItemTemplates,
  WATCH_ITEMS_PER_OBSERVATION,
  type WatchFamily,
  type WatchListItem,
  type WatchStatus,
} from "../shared/watches";
import type { NotificationRaise } from "./notification-center";

/*
 * Pure watch evaluation: one observation of a watched source, with what the
 * watch remembers from earlier observations, becomes the notifications to
 * raise and the keys whose condition cleared. Transitions, never states: a
 * repeated observation decides nothing.
 */

/** Who a watch reports about and how. */
export interface WatchSubject {
  configPath: string;
  dashboardName: string | null;
  nodeId: string;
  /** The node's label, used as every entry's title. */
  label: string;
  family: WatchFamily;
  on: readonly NodeWatchEvent[];
  level: NotificationLevel;
  action?: NodeWatch["action"];
}

/** One read of the source: its decoded value, or why it failed. */
export type WatchObservation = { ok: true; value: unknown } | { ok: false; error: string };

export interface WatchMemory {
  /** A successful observation happened; until then the next one is the baseline. */
  observed: boolean;
  /** Status watches: the last observed state. */
  state?: WatchStatus["state"];
  /** List watches: the IDs of the last observed items. */
  itemIds?: readonly string[];
  /** Reads are failing; the failure was reported once for this streak. */
  failing: boolean;
}

export const INITIAL_WATCH_MEMORY: WatchMemory = Object.freeze({ observed: false, failing: false });

export interface WatchDecision {
  memory: WatchMemory;
  raise: NotificationRaise[];
  resolve: string[];
}

export function watchStateKey(configPath: string, nodeId: string): string {
  return `watch:${configPath}:${nodeId}`;
}

export function watchItemKey(configPath: string, nodeId: string, itemId: string): string {
  return `${watchStateKey(configPath, nodeId)}:item:${itemId}`;
}

export function watchMoreKey(configPath: string, nodeId: string): string {
  return `${watchStateKey(configPath, nodeId)}:more`;
}

export function watchErrorKey(configPath: string, nodeId: string): string {
  return `watch-error:${configPath}:${nodeId}`;
}

export function watchPausedKey(configPath: string): string {
  return `watch-paused:${configPath}`;
}

export function evaluateWatch(subject: WatchSubject, memory: WatchMemory, observation: WatchObservation): WatchDecision {
  if (!observation.ok) return failed(subject, memory, observation.error);
  if (subject.family === "status") {
    const status = parseWatchStatus(observation.value);
    if (!status) return failed(subject, memory, "The source output is not a status; expected { state, detail? } with state unknown, healthy, warning, or error.");
    return evaluateStatus(subject, memory, status);
  }
  const list = parseWatchList(observation.value);
  if ("error" in list) return failed(subject, memory, `The source output is not a list. ${list.error}`);
  return evaluateList(subject, memory, list.items);
}

/** A failure keeps the baseline and reports once per failing streak. */
function failed(subject: WatchSubject, memory: WatchMemory, error: string): WatchDecision {
  if (memory.failing) return { memory, raise: [], resolve: [] };
  return {
    memory: { ...memory, failing: true },
    raise: [{
      ...base(subject),
      key: watchErrorKey(subject.configPath, subject.nodeId),
      kind: "watch-error",
      level: "inform",
      message: `Watch failed: ${error}`,
      target: { kind: "node", nodeId: subject.nodeId },
    }],
    resolve: [],
  };
}

function evaluateStatus(subject: WatchSubject, memory: WatchMemory, status: WatchStatus): WatchDecision {
  const key = watchStateKey(subject.configPath, subject.nodeId);
  const notified = (state: WatchStatus["state"] | undefined): boolean =>
    state !== undefined && state !== "healthy" && subject.on.includes(state);
  const raise: NotificationRaise[] = [];
  const resolve: string[] = memory.failing ? [watchErrorKey(subject.configPath, subject.nodeId)] : [];
  if (!memory.observed) {
    // The baseline: an already notified state lands in the inbox without interrupting.
    if (notified(status.state)) raise.push(stateRaise(subject, status, true));
    else resolve.push(key);
  } else if (notified(status.state)) {
    if (memory.state !== status.state) raise.push(stateRaise(subject, status, false));
  } else if (notified(memory.state)) {
    // Recovery closes the decision; it is not news of its own.
    resolve.push(key);
  }
  return { memory: { observed: true, state: status.state, failing: false }, raise, resolve };
}

function stateRaise(subject: WatchSubject, status: WatchStatus, quiet: boolean): NotificationRaise {
  const state = `${status.state[0]!.toUpperCase()}${status.state.slice(1)}`;
  const action = statusAction(subject);
  return {
    ...base(subject),
    key: watchStateKey(subject.configPath, subject.nodeId),
    kind: "watch-state",
    level: subject.level,
    message: status.detail ? `${state}: ${status.detail}` : state,
    target: { kind: "node", nodeId: subject.nodeId },
    ...(action ? { action } : {}),
    ...(quiet ? { quiet: true } : {}),
  };
}

function evaluateList(subject: WatchSubject, memory: WatchMemory, items: readonly WatchListItem[]): WatchDecision {
  const ids = items.map((item) => item.id);
  const resolve: string[] = memory.failing ? [watchErrorKey(subject.configPath, subject.nodeId)] : [];
  const next: WatchMemory = { observed: true, itemIds: ids, failing: false };
  // The baseline only records which items exist.
  if (!memory.observed) return { memory: next, raise: [], resolve };
  const previous = new Set(memory.itemIds ?? []);
  const current = new Set(ids);
  for (const id of previous) {
    if (!current.has(id)) resolve.push(watchItemKey(subject.configPath, subject.nodeId, id));
  }
  const added = items.filter((item) => !previous.has(item.id));
  const raise = added.slice(0, WATCH_ITEMS_PER_OBSERVATION).map((item) => itemRaise(subject, item));
  const more = added.length - WATCH_ITEMS_PER_OBSERVATION;
  if (more > 0) {
    const action = resolvedAction(subject, {});
    raise.push({
      ...base(subject),
      key: watchMoreKey(subject.configPath, subject.nodeId),
      kind: "watch-item",
      level: subject.level,
      message: `${more} more new item${more === 1 ? "" : "s"}`,
      target: { kind: "node", nodeId: subject.nodeId },
      ...(action ? { action } : {}),
    });
  }
  return { memory: next, raise, resolve };
}

function itemRaise(subject: WatchSubject, item: WatchListItem): NotificationRaise {
  const action = resolvedAction(subject, item.fields);
  return {
    ...base(subject),
    key: watchItemKey(subject.configPath, subject.nodeId, item.id),
    kind: "watch-item",
    level: subject.level,
    message: item.detail ? `${item.title} — ${item.detail}` : item.title,
    target: { kind: "node", nodeId: subject.nodeId, itemId: item.id },
    ...(action ? { action } : {}),
  };
}

function statusAction(subject: WatchSubject): NotificationAction | undefined {
  const action = subject.action;
  if (!action) return undefined;
  return { label: action.name, invocation: action.with === undefined ? { run: action.run } : { run: action.run, with: structuredClone(action.with) } };
}

/** The declared action with this item's fields filled in; omitted when a template cannot resolve. */
function resolvedAction(subject: WatchSubject, fields: Record<string, unknown>): NotificationAction | undefined {
  const action = subject.action;
  if (!action) return undefined;
  if (action.with === undefined) return { label: action.name, invocation: { run: action.run } };
  try {
    const args = resolveItemTemplates(action.with, fields);
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    return { label: action.name, invocation: { run: action.run, with: args as Record<string, unknown> } };
  } catch {
    return undefined;
  }
}

function base(subject: WatchSubject): Pick<NotificationRaise, "configPath" | "dashboardName" | "title"> {
  return { configPath: subject.configPath, dashboardName: subject.dashboardName, title: subject.label };
}
