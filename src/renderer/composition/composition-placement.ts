import type {
  ComponentChildLocator,
  ComponentChildPlacement,
  ComponentManifest,
  ComponentNode,
  DashboardInsertionTarget,
} from "../../shared/contracts";
import { childEdges } from "../../shared/child-edges";
import { childLocators, sameLocator } from "../lib/component-children";

type TiledPlacement = Extract<ComponentChildPlacement, { type: "tiled" }>;

export interface CompositionPlacementContext {
  /** Component whose declared child boundary is being targeted. */
  target: ComponentNode;
  manifest: ComponentManifest | null | undefined;
  /** Path to target from the owning dashboard root. */
  parentPath?: readonly ComponentChildLocator[];
  /** Fail-closed snapshot of the child count observed by the caller. */
  currentChildCount?: number;
  /** Optional existing child around which insertion targets should be derived. */
  targetChildPath?: ComponentChildLocator;
}

function cloneLocator(locator: ComponentChildLocator): ComponentChildLocator {
  return locator.type === "managed"
    ? { type: "managed", index: locator.index }
    : { type: "tiled", path: [...locator.path] };
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
  if (target.children && (Array.isArray(target.children) ? "managed" : "tiled") !== presentation.type) return [];

  const parentPath = context.parentPath ?? [];
  const requestedChild = context.targetChildPath;

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
