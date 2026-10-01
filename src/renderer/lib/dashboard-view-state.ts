import type { ResolvedComponentNode } from "../../shared/contracts";
import {
  collapsedComponentsStorageKey,
  collectComponentNodeIds,
  parseCollapsedComponentIds,
  pruneChildSelections,
  parseChildSelections,
  serializeChildSelections,
  serializeCollapsedComponentIds,
  childSelectionsStorageKey,
} from "./component-view-state";
import {
  componentHeightOverridesStorageKey,
  parseComponentHeightOverrides,
  pruneComponentHeightOverrides,
  serializeComponentHeightOverrides,
  type ComponentHeightOverrides,
} from "./component-height";
import {
  parseSplitRatioOverrides,
  pruneSplitRatioOverrides,
  serializeSplitRatioOverrides,
  type SplitRatioOverrides,
  splitRatioOverridesStorageKey,
} from "../render/split-layout";
import { findVirtualRootPath, resolveVirtualRoot, virtualRootStorageKey } from "./virtual-root";

export interface DashboardViewState {
  virtualRoot: string | null;
  collapsed: ReadonlySet<string>;
  splits: Readonly<SplitRatioOverrides>;
  heights: Readonly<ComponentHeightOverrides>;
  selections: Readonly<Record<string, string>>;
}

interface ViewStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Entry {
  state: DashboardViewState;
  revision: number;
  snapshots: WeakMap<ResolvedComponentNode, { revision: number; state: DashboardViewState }>;
  /** Tree and focus whose ancestor path was last expanded; later user collapses stand. */
  expandedFor: { tree: ResolvedComponentNode; virtualRoot: string | null } | null;
}

const EMPTY_VIEW_STATE: DashboardViewState = {
  virtualRoot: null,
  collapsed: new Set(),
  splits: {},
  heights: {},
  selections: {},
};

const storageKeys = (path: string) => [
  virtualRootStorageKey(path),
  collapsedComponentsStorageKey(path),
  splitRatioOverridesStorageKey(path),
  componentHeightOverridesStorageKey(path),
  childSelectionsStorageKey(path),
];

function browserStorage(): ViewStateStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readValue(storage: ViewStateStorage | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function decode(storage: ViewStateStorage | null, path: string): DashboardViewState {
  const virtualRoot = readValue(storage, virtualRootStorageKey(path));
  return {
    virtualRoot: virtualRoot && virtualRoot.length > 0 ? virtualRoot : null,
    collapsed: parseCollapsedComponentIds(readValue(storage, collapsedComponentsStorageKey(path))),
    splits: parseSplitRatioOverrides(readValue(storage, splitRatioOverridesStorageKey(path))),
    heights: parseComponentHeightOverrides(readValue(storage, componentHeightOverridesStorageKey(path))),
    selections: parseChildSelections(readValue(storage, childSelectionsStorageKey(path))),
  };
}

function writeValue(storage: ViewStateStorage | null, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* Keep the renderer state for this session. */ }
}

function encode(
  storage: ViewStateStorage | null,
  path: string,
  previous: DashboardViewState,
  state: DashboardViewState,
): void {
  if (previous.virtualRoot !== state.virtualRoot) {
    const rootKey = virtualRootStorageKey(path);
    try {
      if (state.virtualRoot) storage?.setItem(rootKey, state.virtualRoot);
      else storage?.removeItem(rootKey);
    } catch { /* Keep the renderer state for this session. */ }
  }
  if (serializeCollapsedComponentIds(previous.collapsed) !== serializeCollapsedComponentIds(state.collapsed)) {
    writeValue(storage, collapsedComponentsStorageKey(path), serializeCollapsedComponentIds(state.collapsed));
  }
  if (serializeSplitRatioOverrides(previous.splits) !== serializeSplitRatioOverrides(state.splits)) {
    writeValue(storage, splitRatioOverridesStorageKey(path), serializeSplitRatioOverrides(state.splits));
  }
  if (serializeComponentHeightOverrides(previous.heights) !== serializeComponentHeightOverrides(state.heights)) {
    writeValue(storage, componentHeightOverridesStorageKey(path), serializeComponentHeightOverrides(state.heights));
  }
  if (serializeChildSelections(previous.selections) !== serializeChildSelections(state.selections)) {
    writeValue(storage, childSelectionsStorageKey(path), serializeChildSelections(state.selections));
  }
}

/** Drop IDs the tree no longer contains. */
function prune(state: DashboardViewState, tree: ResolvedComponentNode): DashboardViewState {
  const virtualRoot = state.virtualRoot && findVirtualRootPath(tree, state.virtualRoot)
    ? state.virtualRoot
    : null;
  const validIds = collectComponentNodeIds(tree);
  const collapsed = new Set([...state.collapsed].filter((id) => validIds.has(id)));
  return {
    virtualRoot,
    collapsed,
    splits: pruneSplitRatioOverrides(state.splits, tree),
    heights: pruneComponentHeightOverrides(state.heights, tree),
    selections: pruneChildSelections(state.selections, tree),
  };
}

/** Expand the focused node and its ancestors so the focus is visible. */
function expandFocusPath(state: DashboardViewState, tree: ResolvedComponentNode): DashboardViewState {
  if (!state.virtualRoot) return state;
  const expanded = new Set<string>();
  const resolvedFocus = resolveVirtualRoot(tree, state.virtualRoot);
  for (const { id } of findVirtualRootPath(tree, state.virtualRoot) ?? []) expanded.add(id);
  for (const id of resolvedFocus.retainedAncestorIds) expanded.add(id);
  if (![...state.collapsed].some((id) => expanded.has(id))) return state;
  return { ...state, collapsed: new Set([...state.collapsed].filter((id) => !expanded.has(id))) };
}

function needsFocusExpansion(entry: Entry, tree: ResolvedComponentNode, virtualRoot: string | null): boolean {
  return entry.expandedFor?.tree !== tree || entry.expandedFor.virtualRoot !== virtualRoot;
}

function sameState(left: DashboardViewState, right: DashboardViewState): boolean {
  return left.virtualRoot === right.virtualRoot
    && serializeCollapsedComponentIds(left.collapsed) === serializeCollapsedComponentIds(right.collapsed)
    && serializeSplitRatioOverrides(left.splits) === serializeSplitRatioOverrides(right.splits)
    && serializeComponentHeightOverrides(left.heights) === serializeComponentHeightOverrides(right.heights)
    && serializeChildSelections(left.selections) === serializeChildSelections(right.selections);
}

/** One path-keyed owner and compatibility codec for renderer-only dashboard view state. */
export class DashboardViewStateStore {
  private readonly entries = new Map<string, Entry>();
  private readonly subscribers = new Map<string, Set<() => void>>();

  constructor(private readonly getStorage: () => ViewStateStorage | null = browserStorage) {}

  private entry(path: string): Entry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = { state: decode(this.getStorage(), path), revision: 0, snapshots: new WeakMap(), expandedFor: null };
      this.entries.set(path, entry);
    }
    return entry;
  }

  subscribe(path: string | null, listener: () => void): () => void {
    if (!path) return () => {};
    const listeners = this.subscribers.get(path) ?? new Set<() => void>();
    listeners.add(listener);
    this.subscribers.set(path, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(path);
    };
  }

  private notify(path: string): void {
    for (const listener of this.subscribers.get(path) ?? []) listener();
  }

  getSnapshot(path: string | null, tree?: ResolvedComponentNode | null): DashboardViewState {
    if (!path) return EMPTY_VIEW_STATE;
    const entry = this.entry(path);
    if (!tree) return entry.state;
    const cached = entry.snapshots.get(tree);
    if (cached?.revision === entry.revision) return cached.state;
    let next = prune(entry.state, tree);
    if (needsFocusExpansion(entry, tree, next.virtualRoot)) next = expandFocusPath(next, tree);
    const state = sameState(entry.state, next) ? entry.state : next;
    entry.snapshots.set(tree, { revision: entry.revision, state });
    return state;
  }

  update(
    path: string | null,
    tree: ResolvedComponentNode | null | undefined,
    update: (current: DashboardViewState) => DashboardViewState,
  ): DashboardViewState {
    if (!path) return EMPTY_VIEW_STATE;
    const entry = this.entry(path);
    const current = this.getSnapshot(path, tree);
    let next = update(current);
    if (tree) {
      next = prune(next, tree);
      // A new focus expands its path once; collapsing inside the focus afterwards stands.
      if (next.virtualRoot !== current.virtualRoot) next = expandFocusPath(next, tree);
      entry.expandedFor = { tree, virtualRoot: next.virtualRoot };
    }
    if (sameState(current, next) && sameState(entry.state, next)) return current;
    const previous = entry.state;
    entry.state = next;
    entry.revision += 1;
    entry.snapshots = new WeakMap();
    encode(this.getStorage(), path, previous, next);
    this.notify(path);
    return next;
  }

  reconcile(path: string | null, tree: ResolvedComponentNode | null | undefined): void {
    if (!path || !tree) return;
    const entry = this.entry(path);
    const next = this.getSnapshot(path, tree);
    entry.expandedFor = { tree, virtualRoot: next.virtualRoot };
    if (sameState(entry.state, next)) return;
    const previous = entry.state;
    entry.state = next;
    entry.revision += 1;
    entry.snapshots = new WeakMap();
    encode(this.getStorage(), path, previous, next);
    this.notify(path);
  }

  forget(path: string): void {
    this.entries.delete(path);
    const storage = this.getStorage();
    for (const key of storageKeys(path)) {
      try { storage?.removeItem(key); } catch { /* Forget remaining keys even if one removal fails. */ }
    }
    this.notify(path);
  }
}

export const dashboardViewStateStore = new DashboardViewStateStore();
