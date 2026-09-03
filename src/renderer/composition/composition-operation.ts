import type {
  ComponentCatalogItem,
  ComponentChildLocator,
  ComponentNode,
  DashboardConfig,
  DashboardInsertionTarget,
} from "../../shared/contracts";
import { childEdges, edgeAtLocator } from "../lib/component-children";
import {
  createNode,
  insertNode,
  moveNode,
  nodeAtPath,
  pathStartsWith,
  replaceRoot,
  type NodePath,
} from "./dashboard-editor";
import { deriveInsertionTargets } from "./composition-placement";

/** A replacement is deliberately separate from a child insertion boundary. */
export interface DashboardRootReplacementTarget {
  type: "root-replacement";
  path: [];
}

export type CompositionOperationTarget = DashboardInsertionTarget | DashboardRootReplacementTarget;

/**
 * Component payloads describe a catalog selection plus its configured props.
 * Node payloads name an existing structural edge so its node, ID, props, and
 * edge metadata can move together.
 */
export type CompositionOperationPayload =
  | { type: "component"; reference: string; props?: Record<string, unknown> }
  | { type: "node"; path: NodePath };

export type CompositionOperationRejectionReason =
  | "unavailable-component"
  | "invalid-target"
  | "invalid-source"
  | "root-move"
  | "own-descendant"
  | "constraint"
  | "mutation-failed";

export interface RejectedCompositionOperation {
  status: "rejected";
  reason: CompositionOperationRejectionReason;
  message: string;
}

export interface PlannedCompositionOperation {
  status: "planned";
  kind: "insert" | "replace-root" | "move";
  nextConfig: DashboardConfig;
}

export type CompositionOperationPlan =
  | RejectedCompositionOperation
  | PlannedCompositionOperation;

export interface CompositionOperationRequest {
  config: DashboardConfig;
  catalog: readonly ComponentCatalogItem[];
  payload: CompositionOperationPayload;
  target: CompositionOperationTarget;
}

function rejected(
  reason: CompositionOperationRejectionReason,
  message: string,
): RejectedCompositionOperation {
  return { status: "rejected", reason, message };
}

function isRootTarget(target: CompositionOperationTarget): target is DashboardRootReplacementTarget {
  return "type" in target && target.type === "root-replacement";
}

function sameLocator(left: ComponentChildLocator, right: ComponentChildLocator): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "managed" && right.type === "managed") return left.index === right.index;
  return left.type === "tiled" && right.type === "tiled"
    && left.path.length === right.path.length
    && left.path.every((branch, index) => branch === right.path[index]);
}

function sameInsertionTarget(left: DashboardInsertionTarget, right: DashboardInsertionTarget): boolean {
  if (left.parentPath.length !== right.parentPath.length
    || !left.parentPath.every((locator, index) => sameLocator(locator, right.parentPath[index]!))) {
    return false;
  }
  if (left.placement.type !== right.placement.type) return false;
  if (left.placement.type === "managed" && right.placement.type === "managed") {
    return left.placement.index === right.placement.index;
  }
  if (left.placement.type !== "tiled" || right.placement.type !== "tiled") return false;
  const leftPlacement = left.placement;
  const rightPlacement = right.placement;
  return leftPlacement.axis === rightPlacement.axis
    && leftPlacement.position === rightPlacement.position
    && leftPlacement.path.length === rightPlacement.path.length
    && leftPlacement.path.every((branch, index) => branch === rightPlacement.path[index]);
}

function catalogItem(
  catalog: readonly ComponentCatalogItem[],
  reference: string,
): ComponentCatalogItem | null {
  const item = catalog.find((entry) => entry.reference === reference);
  return item?.available && item.manifest ? item : null;
}

function exactTargetAddressIsValid(config: DashboardConfig, target: DashboardInsertionTarget): boolean {
  let parent: ComponentNode;
  try {
    parent = nodeAtPath(config.root, target.parentPath);
  } catch {
    return false;
  }
  const placement = target.placement;
  if (placement.type === "managed") {
    return Number.isInteger(placement.index)
      && placement.index >= 0
      && placement.index <= childEdges(parent.children).length;
  }
  if (placement.axis !== "horizontal" && placement.axis !== "vertical") return false;
  if (placement.position !== "first" && placement.position !== "second") return false;
  if (!Array.isArray(placement.path)
    || !placement.path.every((branch) => branch === "first" || branch === "second")) return false;
  if (!parent.children) return placement.path.length === 0;
  try {
    edgeAtLocator(parent.children, { type: "tiled", path: placement.path });
    return true;
  } catch {
    return false;
  }
}

function componentInsertionTargetIsValid(
  config: DashboardConfig,
  catalog: readonly ComponentCatalogItem[],
  target: DashboardInsertionTarget,
): boolean {
  if (!exactTargetAddressIsValid(config, target)) return false;
  try {
    const parent = nodeAtPath(config.root, target.parentPath);
    const parentItem = catalogItem(catalog, parent.component);
    if (!parentItem) return false;
    return deriveInsertionTargets({
      target: parent,
      manifest: parentItem.manifest,
      parentPath: target.parentPath,
      currentChildCount: childEdges(parent.children).length,
    }).some((candidate) => sameInsertionTarget(candidate, target));
  } catch {
    return false;
  }
}

/**
 * Plan one structural composition operation without changing the supplied
 * config. Renderer affordances use this exact result for eligibility, and
 * accepted operations apply its nextConfig, so a preflight cannot diverge from
 * the later immutable mutation.
 */
export function planCompositionOperation(
  request: CompositionOperationRequest,
): CompositionOperationPlan {
  const { config, catalog, payload, target } = request;
  if (payload.type === "component") {
    const item = catalogItem(catalog, payload.reference);
    if (!item) return rejected("unavailable-component", "That component is not available.");
    if (isRootTarget(target)) {
      try {
        return {
          status: "planned",
          kind: "replace-root",
          nextConfig: replaceRoot(config, item, payload.props ?? {}),
        };
      } catch (error) {
        return rejected("mutation-failed", error instanceof Error ? error.message : String(error));
      }
    }
    if (!componentInsertionTargetIsValid(config, catalog, target)) {
      return rejected("constraint", "That insertion target no longer satisfies the parent child contract.");
    }
    try {
      const node = createNode(config, item, payload.props ?? {});
      return { status: "planned", kind: "insert", nextConfig: insertNode(config, target, node, catalog) };
    } catch (error) {
      return rejected("mutation-failed", error instanceof Error ? error.message : String(error));
    }
  }

  if (isRootTarget(target)) return rejected("root-move", "The dashboard root cannot be moved.");
  if (payload.path.length === 0) return rejected("root-move", "The dashboard root cannot be moved.");
  try {
    nodeAtPath(config.root, payload.path);
  } catch {
    return rejected("invalid-source", "The component to move no longer exists.");
  }
  if (pathStartsWith(target.parentPath, payload.path)) {
    return rejected("own-descendant", "A component cannot be moved into itself or one of its descendants.");
  }
  if (!exactTargetAddressIsValid(config, target)) {
    return rejected("invalid-target", "The target placement no longer exists.");
  }
  try {
    if (!catalogItem(catalog, nodeAtPath(config.root, target.parentPath).component)) {
      return rejected("constraint", "The target component contract is not available.");
    }
  } catch {
    return rejected("invalid-target", "The target component no longer exists.");
  }
  try {
    return { status: "planned", kind: "move", nextConfig: moveNode(config, payload.path, target, catalog) };
  } catch (error) {
    return rejected("constraint", error instanceof Error ? error.message : String(error));
  }
}

/** Small boolean adapter for render-time eligibility checks. */
export function canPlanCompositionOperation(request: CompositionOperationRequest): boolean {
  return planCompositionOperation(request).status === "planned";
}
