import type {
  ComponentChildLocator,
  ComponentChildPlacement,
  ComponentManifest,
  ComponentNode,
  DashboardInsertionTarget,
} from "../../shared/contracts";
import {
  childEdges,
  childLocators,
  type LayoutBranch,
} from "../lib/component-children";

type TiledPlacement = Extract<ComponentChildPlacement, { type: "tiled" }>;

export type TiledDirection = Pick<TiledPlacement, "axis" | "position">;

export interface CompositionPlacementContext {
  /** Component whose declared child boundary is being targeted. */
  target: ComponentNode;
  manifest: ComponentManifest | null | undefined;
  /** Path to target from the owning dashboard root. */
  parentPath?: readonly ComponentChildLocator[];
  /** Fail-closed snapshot of the child count observed by the caller. */
  currentChildCount?: number;
  /** Optional existing child around which insertion targets should be derived. */
  targetChildPath?: ComponentChildLocator | readonly LayoutBranch[];
}

export interface DashboardRootReplacementTarget {
  type: "root-replacement";
  path: [];
}

export type DashboardCompositionPlacementTarget =
  | DashboardRootReplacementTarget
  | { type: "insertion"; target: DashboardInsertionTarget };

function cloneLocator(locator: ComponentChildLocator): ComponentChildLocator {
  return locator.type === "managed"
    ? { type: "managed", index: locator.index }
    : { type: "tiled", path: [...locator.path] };
}

function normalizeTargetChildPath(
  value: CompositionPlacementContext["targetChildPath"],
): ComponentChildLocator | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value)
    ? { type: "tiled", path: [...value] }
    : cloneLocator(value as ComponentChildLocator);
}

function sameLocator(left: ComponentChildLocator, right: ComponentChildLocator): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "managed" && right.type === "managed") {
    return left.index === right.index;
  }
  return left.type === "tiled" && right.type === "tiled"
    && left.path.length === right.path.length
    && left.path.every((branch, index) => branch === right.path[index]);
}

function cardinalityIsUsable(manifest: ComponentManifest, count: number): boolean {
  const definition = manifest.children;
  if (!definition || !Number.isInteger(count) || count < 0) return false;
  if (!Number.isInteger(definition.min) || definition.min < 0) return false;
  if (definition.max !== undefined) {
    if (!Number.isInteger(definition.max) || definition.max < definition.min) return false;
    if (count >= definition.max) return false;
  }
  return true;
}

function tiledAxes(manifest: ComponentManifest): Array<TiledPlacement["axis"]> {
  const presentation = manifest.children?.presentation;
  if (presentation?.type !== "tiled") return [];
  if (presentation.axes === "horizontal") return ["horizontal"];
  if (presentation.axes === "vertical") return ["vertical"];
  return ["horizontal", "vertical"];
}

function insertionTarget(
  parentPath: readonly ComponentChildLocator[],
  placement: ComponentChildPlacement,
): DashboardInsertionTarget {
  return {
    parentPath: parentPath.map(cloneLocator),
    placement,
  };
}

/**
 * Derive every structurally valid child insertion target for one component.
 * The ordering is stable: managed boundaries are ascending; tiled leaves are
 * depth-first, with left/right before above/below when both axes are allowed.
 */
export function deriveInsertionTargets(
  context: CompositionPlacementContext,
): DashboardInsertionTarget[] {
  const { target, manifest } = context;
  if (!manifest?.children) return [];

  const observedCount = childEdges(target.children).length;
  const currentChildCount = context.currentChildCount ?? observedCount;
  if (currentChildCount !== observedCount || !cardinalityIsUsable(manifest, currentChildCount)) {
    return [];
  }

  const presentation = manifest.children.presentation;
  if (target.children && target.children.type !== presentation.type) return [];

  const parentPath = context.parentPath ?? [];
  const requestedChild = normalizeTargetChildPath(context.targetChildPath);

  if (presentation.type === "managed") {
    if (requestedChild?.type === "tiled") return [];
    if (!target.children) {
      if (requestedChild !== undefined) return [];
      return [insertionTarget(parentPath, { type: "managed", index: 0 })];
    }

    if (requestedChild) {
      if (requestedChild.index < 0 || requestedChild.index >= currentChildCount) return [];
      return [requestedChild.index, requestedChild.index + 1].map((index) =>
        insertionTarget(parentPath, { type: "managed", index }));
    }
    return Array.from({ length: currentChildCount + 1 }, (_, index) =>
      insertionTarget(parentPath, { type: "managed", index }));
  }

  const axes = tiledAxes(manifest);
  if (axes.length === 0 || requestedChild?.type === "managed") return [];
  if (!target.children) {
    if (requestedChild !== undefined) return [];
    return [insertionTarget(parentPath, {
      type: "tiled",
      path: [],
      axis: axes[0]!,
      position: "first",
    })];
  }

  const availableChildren = childLocators(target.children);
  const selectedChildren = requestedChild === undefined
    ? availableChildren
    : availableChildren.filter((locator) => sameLocator(locator, requestedChild));
  if (selectedChildren.length === 0) return [];

  return selectedChildren.flatMap((locator) => {
    if (locator.type !== "tiled") return [];
    return axes.flatMap((axis) => (["first", "second"] as const).map((position) =>
      insertionTarget(parentPath, {
        type: "tiled",
        path: [...locator.path],
        axis,
        position,
      })));
  });
}

export function deriveRootReplacementTarget(
  targetPath: readonly ComponentChildLocator[],
): DashboardRootReplacementTarget | null {
  return targetPath.length === 0 ? { type: "root-replacement", path: [] } : null;
}

/** Includes root replacement when the targeted component is the dashboard root. */
export function deriveCompositionPlacementTargets(
  context: CompositionPlacementContext,
): DashboardCompositionPlacementTarget[] {
  const rootTarget = deriveRootReplacementTarget(context.parentPath ?? []);
  return [
    ...(rootTarget ? [rootTarget] : []),
    ...deriveInsertionTargets(context).map((target) => ({
      type: "insertion" as const,
      target,
    })),
  ];
}

/**
 * Pick the nearest allowed edge of a normalized pointer rectangle. Ties are
 * deterministic and prefer horizontal before vertical, then first before second.
 */
export function inferTiledDirection(
  xRatio: number,
  yRatio: number,
  axes: "horizontal" | "vertical" | "both",
): TiledDirection | null {
  if (
    !Number.isFinite(xRatio)
    || !Number.isFinite(yRatio)
    || xRatio < 0
    || xRatio > 1
    || yRatio < 0
    || yRatio > 1
  ) return null;

  const candidates: Array<TiledDirection & { distance: number; order: number }> = [];
  if (axes !== "vertical") {
    candidates.push(
      { axis: "horizontal", position: "first", distance: xRatio, order: 0 },
      { axis: "horizontal", position: "second", distance: 1 - xRatio, order: 1 },
    );
  }
  if (axes !== "horizontal") {
    candidates.push(
      { axis: "vertical", position: "first", distance: yRatio, order: 2 },
      { axis: "vertical", position: "second", distance: 1 - yRatio, order: 3 },
    );
  }
  candidates.sort((left, right) => left.distance - right.distance || left.order - right.order);
  const selected = candidates[0];
  return selected ? { axis: selected.axis, position: selected.position } : null;
}

/** Resolve pointer geometry through the same compatibility set used by keyboard insertion. */
export function resolvePointerInsertionTarget(
  context: CompositionPlacementContext,
  xRatio: number,
  yRatio: number,
): DashboardInsertionTarget | null {
  const targets = deriveInsertionTargets(context);
  if (targets.length === 0) return null;
  if (!context.target.children) return targets[0]!;

  const presentation = context.manifest?.children?.presentation;
  if (presentation?.type === "managed") {
    if (!Number.isFinite(xRatio) || xRatio < 0 || xRatio > 1) return null;
    const requested = normalizeTargetChildPath(context.targetChildPath);
    if (requested?.type !== "managed") return targets[0]!;
    const preferredIndex = xRatio <= 0.5 ? requested.index : requested.index + 1;
    return targets.find(({ placement }) =>
      placement.type === "managed" && placement.index === preferredIndex,
    ) ?? null;
  }
  if (presentation?.type !== "tiled") return null;
  const direction = inferTiledDirection(xRatio, yRatio, presentation.axes);
  if (!direction) return null;
  return targets.find(({ placement }) => placement.type === "tiled"
    && placement.axis === direction.axis
    && placement.position === direction.position) ?? null;
}
