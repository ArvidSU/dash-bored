import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { normalizeComponentHeight, type ComponentHeightOverrides } from "../lib/component-height";
import { dashboardViewStateStore } from "../lib/dashboard-view-state";
import {
  normalizeSplitRatio,
  splitRatioMatches,
  type SplitRatioOverrides,
} from "../render/split-layout";
import { findVirtualRootPath, resolveVirtualRoot, revealFocusTarget } from "../lib/virtual-root";
import { scrollNodeIntoView } from "../lib/reveal-item";

/** Renderer-owned per-dashboard presentation state. It never enters YAML or a draft. */
export function useDashboardViewState(
  dashboardPath: string | null,
  tree: ResolvedComponentNode | null | undefined,
): {
  storedVirtualRoot: string | null;
  /** The focused target resolved against the tree, or null without a tree. */
  virtualRoot: ReturnType<typeof resolveVirtualRoot> | null;
  activeCollapsedComponentIds: ReadonlySet<string>;
  activeSplitRatioOverrides: Readonly<SplitRatioOverrides>;
  activeComponentHeightOverrides: Readonly<ComponentHeightOverrides>;
  activeChildSelections: Readonly<Record<string, string>>;
  storeVirtualRoot: (targetDashboardPath: string, nodeId: string) => void;
  expandComponent: (targetDashboardPath: string, nodeId: string) => void;
  toggleComponentCollapse: (nodeId: string) => void;
  updateSplitRatio: (branchKey: string, defaultRatio: number, ratio: number | null) => void;
  updateComponentHeight: (nodeId: string, height: number | null) => void;
  focusComponent: (nodeId: string) => void;
  revealComponent: (nodeId: string) => void;
  selectChild: (containerId: string, childId: string) => void;
  forgetDashboard: (configPath: string) => void;
} {
  const subscribe = useCallback(
    (listener: () => void) => dashboardViewStateStore.subscribe(dashboardPath, listener),
    [dashboardPath],
  );
  const getSnapshot = useCallback(
    () => dashboardViewStateStore.getSnapshot(dashboardPath, tree),
    [dashboardPath, tree],
  );
  const getServerSnapshot = useCallback(
    () => dashboardViewStateStore.getSnapshot(null),
    [],
  );
  const viewState = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useLayoutEffect(() => {
    dashboardViewStateStore.reconcile(dashboardPath, tree);
  }, [dashboardPath, tree]);
  const virtualRoot = tree ? resolveVirtualRoot(tree, viewState.virtualRoot ?? null) : null;
  const virtualRootId = virtualRoot?.target.id;
  useLayoutEffect(() => {
    if (virtualRootId) scrollNodeIntoView(virtualRootId);
  }, [dashboardPath, virtualRootId]);

  function updatePath(
    path: string | null,
    reducer: Parameters<typeof dashboardViewStateStore.update>[2],
  ): void {
    dashboardViewStateStore.update(path, path === dashboardPath ? tree : undefined, reducer);
  }

  function storeVirtualRoot(targetDashboardPath: string, nodeId: string): void {
    updatePath(targetDashboardPath, (current) => ({ ...current, virtualRoot: nodeId }));
  }

  function expandComponent(targetDashboardPath: string, nodeId: string): void {
    updatePath(targetDashboardPath, (current) => {
      if (!current.collapsed.has(nodeId)) return current;
      const collapsed = new Set(current.collapsed);
      collapsed.delete(nodeId);
      return { ...current, collapsed };
    });
  }

  function toggleComponentCollapse(nodeId: string): void {
    if (!dashboardPath) return;
    updatePath(dashboardPath, (current) => {
      const collapsed = new Set(current.collapsed);
      if (collapsed.has(nodeId)) collapsed.delete(nodeId);
      else collapsed.add(nodeId);
      return { ...current, collapsed };
    });
  }

  function selectChild(containerId: string, childId: string): void {
    if (!dashboardPath) return;
    updatePath(dashboardPath, (current) => current.selections[containerId] === childId
      ? current
      : { ...current, selections: { ...current.selections, [containerId]: childId } });
  }

  function updateSplitRatio(branchKey: string, defaultRatio: number, ratio: number | null): void {
    if (!dashboardPath) return;
    const normalizedDefault = normalizeSplitRatio(defaultRatio);
    updatePath(dashboardPath, (current) => {
      const splits = { ...current.splits };
      if (ratio === null || splitRatioMatches(ratio, normalizedDefault)) {
        if (!Object.hasOwn(splits, branchKey)) return current;
        delete splits[branchKey];
        return { ...current, splits };
      }
      const normalizedRatio = normalizeSplitRatio(ratio);
      const existing = splits[branchKey];
      if (
        existing
        && splitRatioMatches(existing.ratio, normalizedRatio)
        && splitRatioMatches(existing.defaultRatio, normalizedDefault)
      ) return current;
      splits[branchKey] = { ratio: normalizedRatio, defaultRatio: normalizedDefault };
      return { ...current, splits };
    });
  }

  function updateComponentHeight(nodeId: string, height: number | null): void {
    if (!dashboardPath) return;
    updatePath(dashboardPath, (current) => {
      const heights = { ...current.heights };
      const normalized = normalizeComponentHeight(height);
      if (height === null || normalized === undefined) {
        if (!Object.hasOwn(heights, nodeId)) return current;
        delete heights[nodeId];
        return { ...current, heights };
      }
      if (heights[nodeId] === normalized) return current;
      heights[nodeId] = normalized;
      return { ...current, heights };
    });
  }

  function expandAndSelectPath(nodeId: string): void {
    if (!dashboardPath) return;
    const path = tree ? findVirtualRootPath(tree, nodeId) : null;
    for (const crumb of path ?? []) expandComponent(dashboardPath, crumb.id);
    for (let index = 0; index < (path?.length ?? 0) - 1; index += 1) {
      const ancestor = path![index]!.node;
      const definition = ancestor.manifest?.children;
      if (definition?.select !== "single" || !Array.isArray(ancestor.children)) continue;
      selectChild(ancestor.id, path![index + 1]!.id);
    }
  }

  function focusComponent(nodeId: string): void {
    if (!dashboardPath) return;
    const focused = tree ? resolveVirtualRoot(tree, nodeId) : null;
    expandAndSelectPath(nodeId);
    for (const id of focused?.retainedAncestorIds ?? []) expandComponent(dashboardPath, id);
    storeVirtualRoot(dashboardPath, nodeId);
  }

  function revealComponent(nodeId: string): void {
    if (!dashboardPath) return;
    const focusTarget = tree ? revealFocusTarget(tree, viewState.virtualRoot, nodeId) : null;
    if (focusTarget !== null) focusComponent(focusTarget);
    expandAndSelectPath(nodeId);
  }

  function forgetDashboard(configPath: string): void {
    dashboardViewStateStore.forget(configPath);
  }

  return {
    storedVirtualRoot: viewState.virtualRoot,
    virtualRoot,
    activeCollapsedComponentIds: viewState.collapsed,
    activeSplitRatioOverrides: viewState.splits,
    activeComponentHeightOverrides: viewState.heights,
    activeChildSelections: viewState.selections,
    storeVirtualRoot,
    expandComponent,
    toggleComponentCollapse,
    updateSplitRatio,
    updateComponentHeight,
    focusComponent,
    revealComponent,
    selectChild,
    forgetDashboard,
  };
}
