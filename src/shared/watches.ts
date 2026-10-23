import { declaredComponentLabel } from "./component-label";
import { childEdges } from "./child-edges";
import type { ComponentResourceDefinitions, NodeWatch, NodeWatchEvent, ResolvedComponentNode } from "./contracts";

/*
 * Node-free watch helpers shared by validation, the main-process runner, and
 * trust review. A watch names transitions of a view's declared data shape;
 * there is no condition or transform language here.
 */

export const WATCH_EVERY_DEFAULT_MS = 300_000;
export const WATCH_EVERY_MIN_MS = 60_000;
export const WATCH_EVERY_MAX_MS = 86_400_000;
/** Watches one config bundle may declare. */
export const WATCH_LIMIT_PER_DASHBOARD = 10;
/** Watches the app runs at once across every registered dashboard. */
export const WATCH_LIMIT_APP = 40;
/** New list items one observation reports individually; the rest coalesce into one entry. */
export const WATCH_ITEMS_PER_OBSERVATION = 5;
export const WATCH_ACTION_NAME_MAX_CHARS = 80;

export const WATCH_STATUS_EVENTS = ["unknown", "warning", "error"] as const satisfies readonly NodeWatchEvent[];
export const WATCH_LIST_EVENTS = ["added"] as const satisfies readonly NodeWatchEvent[];
export const WATCH_EVENTS = [...WATCH_STATUS_EVENTS, ...WATCH_LIST_EVENTS] as const;

/** The view data shape a watch observes, inferred from its `on` events. */
export type WatchFamily = "status" | "list";
export type WatchSourceKind = "shell" | "file" | "http";

export interface WatchSource {
  kind: WatchSourceKind;
  /** The command, project-relative path, or URL. */
  value: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface WatchStatus {
  state: "unknown" | "healthy" | "warning" | "error";
  detail?: string;
}

export interface WatchListItem {
  id: string;
  title: string;
  detail?: string;
  /** Every field the source emitted, for `${item.<field>}` action templates. */
  fields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The family of a valid `on` list; null when it is empty, unknown, or mixes families. */
export function watchFamily(on: readonly unknown[]): WatchFamily | null {
  if (on.length === 0) return null;
  if (on.every((event) => (WATCH_STATUS_EVENTS as readonly unknown[]).includes(event))) return "status";
  if (on.every((event) => (WATCH_LIST_EVENTS as readonly unknown[]).includes(event))) return "list";
  return null;
}

export function watchInterval(watch: Pick<NodeWatch, "every">): number {
  return watch.every ?? WATCH_EVERY_DEFAULT_MS;
}

/** Status states interrupt by default; new list items only inform. */
export function watchLevel(watch: Pick<NodeWatch, "level">, family: WatchFamily): "interrupt" | "inform" {
  return watch.level ?? (family === "status" ? "interrupt" : "inform");
}

/** The single observable source of a node's props, or why it cannot be watched. */
export function watchSource(props: Record<string, unknown>, observation?: ComponentResourceDefinitions["observation"]): { source: WatchSource } | { error: string } {
  if (!observation) return { error: "This component does not declare an observation resource." };
  const source = props[observation.sourceProp];
  if (!isRecord(source)) {
    return { error: `A watch needs props.${observation.sourceProp} with exactly one of shell, file, or http.` };
  }
  const kinds = (["shell", "file", "http"] as const).filter((kind) => kind in source);
  if ("inline" in source) {
    return { error: "An inline source never changes, so there is nothing to watch. Use a shell, file, or http source." };
  }
  if ("process" in source) {
    return { error: "A run the user starts already raises a notification when it fails, so a process source needs no watch. Watch a shell, file, or http source." };
  }
  if (kinds.length !== 1) {
    return { error: `A watch needs props.${observation.sourceProp} with exactly one of shell, file, or http.` };
  }
  const kind = kinds[0]!;
  const value = source[kind];
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `props.${observation.sourceProp}.${kind} must be a non-empty string.` };
  }
  const env = isRecord(source.env) && Object.values(source.env).every((entry) => typeof entry === "string")
    ? source.env as Record<string, string>
    : undefined;
  return {
    source: {
      kind,
      value,
      ...(typeof source.timeoutMs === "number" ? { timeoutMs: source.timeoutMs } : {}),
      ...(typeof source.cwd === "string" ? { cwd: source.cwd } : {}),
      ...(env ? { env } : {}),
    },
  };
}

/** Decode source text like the core views: JSON when it parses, else the text itself. */
export function decodeWatchSourceText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Public observable status protocol: `{ state, detail? }` shape; null when the value does not match it. */
export function parseWatchStatus(value: unknown): WatchStatus | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (state !== "unknown" && state !== "healthy" && state !== "warning" && state !== "error") return null;
  if (value.detail !== undefined && typeof value.detail !== "string") return null;
  return { state, ...(typeof value.detail === "string" && value.detail.trim() ? { detail: value.detail } : {}) };
}

/**
 * Public observable item protocol: a JSON array of objects with
 * unique, non-empty string IDs. Items are tracked by ID alone, so a missing or
 * duplicated ID makes the whole observation a shape error.
 */
export function parseWatchList(value: unknown): { items: WatchListItem[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "Expected a JSON array of list items." };
  const items: WatchListItem[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) return { error: `Item ${index + 1} must be an object with string id and title fields.` };
    const id = candidate.id;
    if (typeof id !== "string" || id.trim() === "") return { error: `Item ${index + 1} needs a non-empty string id.` };
    if (ids.has(id)) return { error: `Item id ${JSON.stringify(id)} is duplicated; IDs must be unique.` };
    ids.add(id);
    const title = typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : id;
    const detail = typeof candidate.detail === "string" && candidate.detail.trim() ? candidate.detail.trim() : undefined;
    items.push({ id, title, ...(detail ? { detail } : {}), fields: candidate });
  }
  return { items };
}

const ITEM_TEMPLATE = /^\$\{item\.([A-Za-z][A-Za-z0-9_-]*)\}$/;

/** Whether any string in an action argument value names a list item field. */
export function containsItemTemplate(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${item.");
  if (Array.isArray(value)) return value.some(containsItemTemplate);
  if (isRecord(value)) return Object.values(value).some(containsItemTemplate);
  return false;
}

/**
 * Resolve whole-value `${item.<field>}` templates, like list `itemActions`.
 * Throws when a field is missing or a template is embedded in other text.
 */
export function resolveItemTemplates(value: unknown, item: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const match = ITEM_TEMPLATE.exec(value);
    if (match) {
      const field = match[1]!;
      if (!Object.prototype.hasOwnProperty.call(item, field) || item[field] === undefined) {
        throw new Error(`item.${field} is missing from this source item.`);
      }
      return copyJsonValue(item[field], `item.${field}`);
    }
    if (value.includes("${item.")) throw new Error("Item templates must be the full value of an action argument.");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveItemTemplates(entry, item));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Action arguments must contain JSON values.");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveItemTemplates(entry, item)]));
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  throw new Error("Action arguments must contain JSON values or item field templates.");
}

function copyJsonValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => copyJsonValue(entry, field));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} has an unsupported value type.`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyJsonValue(entry, field)]));
  }
  throw new Error(`${field} has an unsupported value type.`);
}

/** A short human interval such as "5 min" or "1 h". */
export function formatWatchInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** What a watch runs, for trust review and inspection. */
export function describeWatchSource(source: WatchSource): string {
  switch (source.kind) {
    case "shell": return `runs ${source.value}`;
    case "file": return `reads ${source.value}`;
    case "http": return `requests ${source.value}`;
  }
}

/** The label bound by the component manifest, else the node ID. */
export function watchNodeLabel(node: Pick<ResolvedComponentNode, "id" | "props" | "manifest">): string {
  return declaredComponentLabel(node) ?? node.id;
}

export interface WatchSummary {
  nodeId: string;
  label: string;
  on: NodeWatchEvent[];
  every: number;
  level: "interrupt" | "inform";
  /** What the watch runs, or null when its node has no watchable source. */
  source: WatchSource | null;
  description: string;
  action?: string;
}

/**
 * Every watch in a resolved tree, in tree order. Pass `configPath` to keep
 * only the watches that bundle owns; linked bundles run their own.
 */
export function watchSummaries(tree: ResolvedComponentNode | null | undefined, configPath?: string): WatchSummary[] {
  const summaries: WatchSummary[] = [];
  const visit = (node: ResolvedComponentNode): void => {
    const watch = node.watch;
    if (watch && Array.isArray(watch.on) && (configPath === undefined || (node.sourceConfigPath ?? configPath) === configPath)) {
      const family = watchFamily(watch.on) ?? "status";
      const resolved = watchSource(node.props, node.manifest?.resources?.observation);
      const source = "source" in resolved ? resolved.source : null;
      const every = watchInterval(watch);
      summaries.push({
        nodeId: node.id,
        label: watchNodeLabel(node),
        on: [...watch.on],
        every,
        level: watchLevel(watch, family),
        source,
        description: `${source ? describeWatchSource(source) : "has no watchable source"} every ${formatWatchInterval(every)}`,
        ...(watch.action ? { action: watch.action.name } : {}),
      });
    }
    for (const edge of childEdges(node.children)) visit(edge.node);
  };
  if (tree) visit(tree);
  return summaries;
}
