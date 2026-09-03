import type { ComponentCatalogItem, ComponentNode, DashboardConfig } from "../../shared/contracts";
import { catalogManifest, nodeAtPath, type InsertionTarget, type NodePath } from "./dashboard-editor";
import { edgeAtLocator } from "../lib/component-children";
import type {
  CompositionDragPayload,
  CompositionDropZone,
  CompositionTarget,
} from "./composition-context";

export function compositionTargetId(target: CompositionTarget): string {
  return JSON.stringify(target);
}

export function isRootCompositionTarget(
  target: CompositionTarget,
): target is { type: "root-replacement"; path: [] } {
  return "type" in target && target.type === "root-replacement";
}

export function compositionTargetLabel(target: CompositionTarget): string {
  if (isRootCompositionTarget(target)) return "Replace dashboard root";
  const placement = target.placement;
  if (placement.type === "managed") return `Insert child ${placement.index + 1}`;
  if (placement.axis === "horizontal") return placement.position === "first" ? "Tile left" : "Tile right";
  return placement.position === "first" ? "Tile above" : "Tile below";
}

export function configuredNodeLabel(
  node: ComponentNode,
  catalog: readonly ComponentCatalogItem[],
  metadata: Record<string, unknown> = {},
): string {
  const edgeLabel = metadata.label;
  if (typeof edgeLabel === "string" && edgeLabel.trim()) return edgeLabel.trim();
  const title = node.props?.title ?? node.props?.label ?? node.props?.name;
  if (typeof title === "string" && title.trim()) return title.trim();
  return catalogManifest(catalog, node.component)?.name
    ?? node.component.replace(/^@dash-bored\//, "");
}

/** A compact label for the thing currently being placed, not its destination. */
export function compositionPayloadLabel(
  payload: CompositionDragPayload,
  config: DashboardConfig,
  catalog: readonly ComponentCatalogItem[],
): string {
  if (payload.type === "component") {
    return catalogManifest(catalog, payload.reference)?.name
      ?? payload.reference.replace(/^@dash-bored\//, "");
  }
  try {
    return configuredNodeLabel(nodeAtPath(config.root, payload.path), catalog);
  } catch {
    // The move planner will reject an out-of-date source. Keep the transient
    // preview descriptive without treating the stale path as a valid node.
    return "Component";
  }
}

export function contextualInsertionLabel(
  parent: ComponentNode,
  target: InsertionTarget,
  catalog: readonly ComponentCatalogItem[],
): string {
  const placement = target.placement;
  const parentLabel = configuredNodeLabel(parent, catalog);
  if (!parent.children) return `Add inside ${parentLabel}`;
  if (placement.type === "managed") {
    if (parent.children.type !== "managed") return compositionTargetLabel(target);
    const before = parent.children.items[placement.index - 1];
    const after = parent.children.items[placement.index];
    if (!before && after) {
      return `Insert before ${configuredNodeLabel(after.node, catalog, after.metadata)}`;
    }
    if (before && !after) {
      return `Insert after ${configuredNodeLabel(before.node, catalog, before.metadata)}`;
    }
    if (before && after) {
      return `Insert between ${configuredNodeLabel(before.node, catalog, before.metadata)} and ${configuredNodeLabel(after.node, catalog, after.metadata)}`;
    }
    return `Add inside ${parentLabel}`;
  }
  try {
    const edge = edgeAtLocator(parent.children, { type: "tiled", path: placement.path });
    const childLabel = configuredNodeLabel(edge.node, catalog, edge.metadata);
    if (placement.axis === "horizontal") {
      return placement.position === "first"
        ? `Tile left of ${childLabel}`
        : `Tile right of ${childLabel}`;
    }
    return placement.position === "first"
      ? `Tile above ${childLabel}`
      : `Tile below ${childLabel}`;
  } catch {
    return compositionTargetLabel(target);
  }
}

export function compositionDropZoneSide(
  target: InsertionTarget,
  targetChildPath: NodePath[number] | undefined,
): CompositionDropZone["side"] {
  const placement = target.placement;
  if (placement.type === "managed") {
    return targetChildPath?.type === "managed" && placement.index <= targetChildPath.index
      ? "left"
      : "right";
  }
  if (placement.axis === "horizontal") return placement.position === "first" ? "left" : "right";
  return placement.position === "first" ? "top" : "bottom";
}

