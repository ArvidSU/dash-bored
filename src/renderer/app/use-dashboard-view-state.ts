import { useEffect, useState } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import {
  collapsedComponentsStorageKey,
  collectComponentNodeIds,
  parseCollapsedComponentIds,
  serializeCollapsedComponentIds,
  childSelectionsStorageKey,
  parseChildSelections,
  pruneChildSelections,
  serializeChildSelections,
} from "../lib/component-view-state";
import {
  componentHeightOverridesStorageKey,
  normalizeComponentHeight,
  parseComponentHeightOverrides,
  pruneComponentHeightOverrides,
  serializeComponentHeightOverrides,
  type ComponentHeightOverrides,
} from "../lib/component-height";
import {
  normalizeSplitRatio,
  parseSplitRatioOverrides,
  pruneSplitRatioOverrides,
  serializeSplitRatioOverrides,
  splitRatioMatches,
  splitRatioOverridesStorageKey,
  type SplitRatioOverrides,
} from "../render/split-layout";
import { findVirtualRootPath, resolveVirtualRoot, virtualRootStorageKey } from "../lib/virtual-root";
import {
  EMPTY_COLLAPSED_COMPONENT_IDS,
  EMPTY_COMPONENT_HEIGHT_OVERRIDES,
  EMPTY_SPLIT_RATIO_OVERRIDES,
} from "./app-utils";

/**
 * Renderer-owned per-dashboard presentation state: collapse, split ratios,
 * height caps, and virtual-root focus. Persisted to localStorage per config
 * path; never part of the dashboard draft or YAML.
 */
export function useDashboardViewState(
  dashboardPath: string | null,
  tree: ResolvedComponentNode | null | undefined,
): {
  storedVirtualRoot: string | null | undefined;
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
  selectChild: (containerId: string, childId: string) => void;
  forgetDashboard: (configPath: string) => void;
} {
  const [virtualRoots, setVirtualRoots] = useState<Record<string, string | null>>({});
  const [collapsedDashboardPath, setCollapsedDashboardPath] = useState<string | null>(null);
  const [collapsedComponentIds, setCollapsedComponentIds] = useState<Set<string>>(new Set());
  const [splitRatioDashboardPath, setSplitRatioDashboardPath] = useState<string | null>(null);
  const [splitRatioOverrides, setSplitRatioOverrides] = useState<SplitRatioOverrides>({});
  const [componentHeightDashboardPath, setComponentHeightDashboardPath] = useState<string | null>(null);
  const [componentHeightOverrides, setComponentHeightOverrides] = useState<ComponentHeightOverrides>({});
  const [selectionDashboardPath, setSelectionDashboardPath] = useState<string | null>(null);
  const [childSelections, setChildSelections] = useState<Record<string, string>>({});

  const storedVirtualRoot = dashboardPath ? virtualRoots[dashboardPath] : null;
  const activeCollapsedComponentIds = collapsedDashboardPath === dashboardPath
    ? collapsedComponentIds
    : EMPTY_COLLAPSED_COMPONENT_IDS;
  const activeSplitRatioOverrides = splitRatioDashboardPath === dashboardPath
    ? splitRatioOverrides
    : EMPTY_SPLIT_RATIO_OVERRIDES;
  const activeComponentHeightOverrides = componentHeightDashboardPath === dashboardPath
    ? componentHeightOverrides
    : EMPTY_COMPONENT_HEIGHT_OVERRIDES;
  const activeChildSelections = selectionDashboardPath === dashboardPath ? childSelections : {};

  useEffect(() => {
    if (!dashboardPath) { setSelectionDashboardPath(null); setChildSelections({}); return; }
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(childSelectionsStorageKey(dashboardPath)); } catch { /* session-only */ }
    setChildSelections(parseChildSelections(saved));
    setSelectionDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || selectionDashboardPath !== dashboardPath) return;
    try { window.localStorage.setItem(childSelectionsStorageKey(dashboardPath), serializeChildSelections(childSelections)); } catch { /* session-only */ }
  }, [childSelections, dashboardPath, selectionDashboardPath]);

  useEffect(() => {
    if (!dashboardPath || selectionDashboardPath !== dashboardPath || !tree) return;
    setChildSelections((current) => {
      const next = pruneChildSelections(current, tree);
      return serializeChildSelections(next) === serializeChildSelections(current) ? current : next;
    });
  }, [dashboardPath, selectionDashboardPath, tree]);
  useEffect(() => {
    if (!dashboardPath) {
      setCollapsedDashboardPath(null);
      setCollapsedComponentIds(new Set());
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(collapsedComponentsStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable in hardened webviews; collapse state remains session-only.
    }
    setCollapsedComponentIds(parseCollapsedComponentIds(saved));
    setCollapsedDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        collapsedComponentsStorageKey(dashboardPath),
        serializeCollapsedComponentIds(collapsedComponentIds),
      );
    } catch {
      // Collapse state remains available for this session when persistence is unavailable.
    }
  }, [collapsedComponentIds, collapsedDashboardPath, dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath || !tree) return;
    const validIds = collectComponentNodeIds(tree);
    setCollapsedComponentIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [collapsedDashboardPath, dashboardPath, tree]);

  useEffect(() => {
    if (!dashboardPath) {
      setSplitRatioDashboardPath(null);
      setSplitRatioOverrides({});
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(splitRatioOverridesStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable; split overrides remain session-only.
    }
    setSplitRatioOverrides(parseSplitRatioOverrides(saved));
    setSplitRatioDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        splitRatioOverridesStorageKey(dashboardPath),
        serializeSplitRatioOverrides(splitRatioOverrides),
      );
    } catch {
      // Split overrides remain available for this session when persistence is unavailable.
    }
  }, [dashboardPath, splitRatioDashboardPath, splitRatioOverrides]);

  useEffect(() => {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath || !tree) return;
    setSplitRatioOverrides((current) => {
      const next = pruneSplitRatioOverrides(current, tree);
      return serializeSplitRatioOverrides(next) === serializeSplitRatioOverrides(current)
        ? current
        : next;
    });
  }, [dashboardPath, tree, splitRatioDashboardPath]);

  useEffect(() => {
    if (!dashboardPath) {
      setComponentHeightDashboardPath(null);
      setComponentHeightOverrides({});
      return;
    }
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(componentHeightOverridesStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable; height caps remain session-only.
    }
    setComponentHeightOverrides(parseComponentHeightOverrides(saved));
    setComponentHeightDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || componentHeightDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        componentHeightOverridesStorageKey(dashboardPath),
        serializeComponentHeightOverrides(componentHeightOverrides),
      );
    } catch {
      // Height caps remain available for this session when persistence is unavailable.
    }
  }, [componentHeightDashboardPath, componentHeightOverrides, dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || componentHeightDashboardPath !== dashboardPath || !tree) return;
    setComponentHeightOverrides((current) => {
      const next = pruneComponentHeightOverrides(current, tree);
      return serializeComponentHeightOverrides(next) === serializeComponentHeightOverrides(current)
        ? current
        : next;
    });
  }, [componentHeightDashboardPath, dashboardPath, tree]);

  useEffect(() => {
    if (!dashboardPath || Object.hasOwn(virtualRoots, dashboardPath)) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(virtualRootStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable in hardened webviews; focus still works for this session.
    }
    setVirtualRoots((current) => Object.hasOwn(current, dashboardPath)
      ? current
      : { ...current, [dashboardPath]: saved });
  }, [dashboardPath, virtualRoots]);

  useEffect(() => {
    if (!dashboardPath || !tree || !storedVirtualRoot) return;
    const resolved = resolveVirtualRoot(tree, storedVirtualRoot);
    if (resolved.target.id === storedVirtualRoot) return;
    setVirtualRoots((current) => ({ ...current, [dashboardPath]: null }));
    try {
      window.localStorage.removeItem(virtualRootStorageKey(dashboardPath));
    } catch {
      // See the read path above.
    }
  }, [dashboardPath, tree, storedVirtualRoot]);

  useEffect(() => {
    if (
      !dashboardPath
      || collapsedDashboardPath !== dashboardPath
      || !tree
      || !storedVirtualRoot
    ) return;
    const focused = resolveVirtualRoot(tree, storedVirtualRoot);
    if (focused.target.id !== storedVirtualRoot) return;
    const path = findVirtualRootPath(tree, storedVirtualRoot);
    const expandedIds = new Set(path?.map((crumb) => crumb.id) ?? [focused.target.id]);
    setCollapsedComponentIds((current) => {
      if (![...expandedIds].some((id) => current.has(id))) return current;
      return new Set([...current].filter((id) => !expandedIds.has(id)));
    });
    for (let index = 0; index < (path?.length ?? 0) - 1; index += 1) {
      const ancestor = path![index]!.node;
      if (ancestor.manifest?.children?.select === "single" && Array.isArray(ancestor.children)) {
        const childId = path![index + 1]!.id;
        setChildSelections((current) => current[ancestor.id] === childId
          ? current
          : { ...current, [ancestor.id]: childId });
      }
    }
  }, [collapsedDashboardPath, dashboardPath, storedVirtualRoot, tree]);
  function storeVirtualRoot(targetDashboardPath: string, nodeId: string): void {
    setVirtualRoots((current) => ({ ...current, [targetDashboardPath]: nodeId }));
    try {
      window.localStorage.setItem(virtualRootStorageKey(targetDashboardPath), nodeId);
    } catch {
      // Session state remains usable when persistence is unavailable.
    }
  }

  function expandComponent(targetDashboardPath: string, nodeId: string): void {
    if (collapsedDashboardPath === targetDashboardPath) {
      setCollapsedComponentIds((current) => {
        if (!current.has(nodeId)) return current;
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(collapsedComponentsStorageKey(targetDashboardPath));
      const ids = parseCollapsedComponentIds(saved);
      if (!ids.delete(nodeId)) return;
      window.localStorage.setItem(
        collapsedComponentsStorageKey(targetDashboardPath),
        serializeCollapsedComponentIds(ids),
      );
    } catch {
      // The target dashboard will still render the focused node when its state is unavailable.
    }
  }

  function toggleComponentCollapse(nodeId: string): void {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath) return;
    setCollapsedComponentIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function selectChild(containerId: string, childId: string): void {
    if (!dashboardPath || selectionDashboardPath !== dashboardPath) return;
    setChildSelections((current) => current[containerId] === childId ? current : { ...current, [containerId]: childId });
  }

  function updateSplitRatio(
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
  ): void {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath) return;
    const normalizedDefault = normalizeSplitRatio(defaultRatio);
    setSplitRatioOverrides((current) => {
      if (ratio === null || splitRatioMatches(ratio, normalizedDefault)) {
        const next = Object.fromEntries(Object.entries(current));
        if (!Object.hasOwn(next, branchKey)) return current;
        delete next[branchKey];
        return next;
      }
      const normalizedRatio = normalizeSplitRatio(ratio);
      const existing = current[branchKey];
      if (
        existing &&
        splitRatioMatches(existing.ratio, normalizedRatio) &&
        splitRatioMatches(existing.defaultRatio, normalizedDefault)
      ) return current;
      return {
        ...current,
        [branchKey]: {
          ratio: normalizedRatio,
          defaultRatio: normalizedDefault,
        },
      };
    });
  }

  function updateComponentHeight(nodeId: string, height: number | null): void {
    if (!dashboardPath) return;
    setComponentHeightOverrides((current) => {
      const next = Object.fromEntries(Object.entries(current));
      const normalized = normalizeComponentHeight(height);
      if (height === null || normalized === undefined) {
        if (!Object.hasOwn(next, nodeId)) return current;
        delete next[nodeId];
        return next;
      }
      if (next[nodeId] === normalized) return current;
      next[nodeId] = normalized;
      return next;
    });
  }

  function forgetDashboard(configPath: string): void {
    setVirtualRoots((current) => {
      if (!Object.hasOwn(current, configPath)) return current;
      const next = { ...current };
      delete next[configPath];
      return next;
    });
    try {
      window.localStorage.removeItem(virtualRootStorageKey(configPath));
      window.localStorage.removeItem(splitRatioOverridesStorageKey(configPath));
      window.localStorage.removeItem(componentHeightOverridesStorageKey(configPath));
      window.localStorage.removeItem(childSelectionsStorageKey(configPath));
    } catch {
      // The in-memory focus, split, and component-height state has already been cleared.
    }
  }

  function focusComponent(nodeId: string): void {
    if (!dashboardPath) return;
    const focused = tree ? resolveVirtualRoot(tree, nodeId) : null;
    const path = tree ? findVirtualRootPath(tree, nodeId) : null;
    for (const crumb of path ?? []) expandComponent(dashboardPath, crumb.id);
    for (const id of focused?.retainedAncestorIds ?? []) expandComponent(dashboardPath, id);
    for (let index = 0; index < (path?.length ?? 0) - 1; index += 1) {
      const ancestor = path![index]!.node;
      const definition = ancestor.manifest?.children;
      if (definition?.select !== "single" || !Array.isArray(ancestor.children)) continue;
      const directChildId = path![index + 1]!.id;
      selectChild(ancestor.id, directChildId);
    }
    storeVirtualRoot(dashboardPath, nodeId);
  }

  return {
    storedVirtualRoot,
    activeCollapsedComponentIds,
    activeSplitRatioOverrides,
    activeComponentHeightOverrides,
    activeChildSelections,
    storeVirtualRoot,
    expandComponent,
    toggleComponentCollapse,
    updateSplitRatio,
    updateComponentHeight,
    focusComponent,
    selectChild,
    forgetDashboard,
  };
}
