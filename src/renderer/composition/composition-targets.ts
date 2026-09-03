import type {
  ComponentCatalogItem,
  DashboardConfig,
  ResolvedComponentNode,
} from "../../shared/contracts";
import {
  catalogManifest,
  defaultChildMetadata,
  nodeAtPath,
  nodePathById,
  nodePathFromSourcePath,
  type InsertionTarget,
  type NodePath,
} from "./dashboard-editor";
import { childEdges } from "../lib/component-children";
import { deriveInsertionTargets } from "./composition-placement";
import { planCompositionOperation } from "./composition-operation";
import { compatibleCompositionDropZones } from "./composition-dnd";
import type {
  CompositionDragPayload,
  CompositionDropZone,
  CompositionTarget,
} from "./composition-context";
import type { ComponentPointerDragPoint } from "./CompositionFlyout";
import { resolvedNodeById } from "../app/app-utils";
import {
  compositionDropZoneSide,
  compositionTargetId,
  contextualInsertionLabel,
} from "./composition-labels";

export interface CompositionResolution {
  config: DashboardConfig | null;
  catalog: readonly ComponentCatalogItem[];
  previewTree: ResolvedComponentNode | null;
  owningConfigPath: string | null | undefined;
  dragging: CompositionDragPayload | null;
}

/**
 * Pure composition-target resolution over a draft config: node paths,
 * compatible drop zones, pointer-hit zones, validity, and default targets.
 * Created per render via `useMemo`; the returned functions are stable for
 * that resolution and close over no component state.
 */
export function createCompositionTargets(resolution: CompositionResolution): {
  pathForNode: (node: ResolvedComponentNode) => NodePath | null;
  dropZonesForNode: (
    node: ResolvedComponentNode,
    payload?: CompositionDragPayload | null,
  ) => CompositionDropZone[];
  pointerDropZoneForNode: (
    node: ResolvedComponentNode,
    xRatio: number,
    yRatio: number,
    payload?: CompositionDragPayload | null,
  ) => CompositionDropZone | null;
  pointerTargetAt: (
    point: ComponentPointerDragPoint,
    payload: CompositionDragPayload,
  ) => { node: ResolvedComponentNode; zone: CompositionDropZone } | null;
  targetIsValid: (target: CompositionTarget, payload: CompositionDragPayload) => boolean;
  defaultTarget: () => CompositionTarget | null;
} {
  const {
    config: compositionConfig,
    catalog: compositionCatalog,
    previewTree: compositionPreviewTree,
    owningConfigPath,
    dragging: compositionDrag,
  } = resolution;
  function compositionPathForNode(node: ResolvedComponentNode): NodePath | null {
    if (!compositionConfig) return null;
    if (owningConfigPath && node.sourceConfigPath === owningConfigPath && node.sourcePath) {
      const sourcePath = nodePathFromSourcePath(node.sourcePath);
      if (sourcePath) return sourcePath;
    }
    try {
      return nodePathById(compositionConfig.root, node.id);
    } catch {
      return null;
    }
  }

  function decorateCompositionInsertionTarget(
    target: InsertionTarget,
    manifest: ComponentCatalogItem["manifest"],
    childCount: number,
  ): InsertionTarget {
    const metadata = manifest ? defaultChildMetadata(manifest, target.placement.type === "managed"
      ? target.placement.index
      : childCount) : {};
    return Object.keys(metadata).length === 0
      ? target
      : { ...target, placement: { ...target.placement, metadata } };
  }

  function compositionDropZonesForNode(
    node: ResolvedComponentNode,
    payload: CompositionDragPayload | null = compositionDrag,
  ): CompositionDropZone[] {
    if (!compositionConfig) return [];
    const path = compositionPathForNode(node);
    if (!path) return [];
    try {
      if (path.length === 0) {
        const rawRoot = nodeAtPath(compositionConfig.root, path);
        if (rawRoot.children) return [];
        const manifest = catalogManifest(compositionCatalog, rawRoot.component);
        return compatibleCompositionDropZones(
          deriveInsertionTargets({
            target: rawRoot,
            manifest,
            parentPath: path,
            currentChildCount: childEdges(rawRoot.children).length,
          }).map((target) => {
            const decorated = decorateCompositionInsertionTarget(target, manifest, 0);
            return {
              id: compositionTargetId(decorated),
              label: contextualInsertionLabel(rawRoot, decorated, compositionCatalog),
              side: "inside" as const,
              target: decorated,
            };
          }),
          payload,
          compositionTargetIsValid,
        );
      }
      const parentPath = path.slice(0, -1);
      const targetChildPath = path.at(-1);
      if (!targetChildPath) return [];
      const parent = nodeAtPath(compositionConfig.root, parentPath);
      const manifest = catalogManifest(compositionCatalog, parent.component);
      const childCount = childEdges(parent.children).length;
      return compatibleCompositionDropZones(
        deriveInsertionTargets({
          target: parent,
          manifest,
          parentPath,
          targetChildPath,
          currentChildCount: childCount,
        }).map((target) => {
          const decorated = decorateCompositionInsertionTarget(target, manifest, childCount);
          return {
            id: compositionTargetId(decorated),
            label: contextualInsertionLabel(parent, decorated, compositionCatalog),
            side: compositionDropZoneSide(decorated, targetChildPath),
            target: decorated,
          };
        }),
        payload,
        compositionTargetIsValid,
      );
    } catch {
      return [];
    }
  }

  function compositionPointerDropZone(
    node: ResolvedComponentNode,
    xRatio: number,
    yRatio: number,
    payload: CompositionDragPayload | null = compositionDrag,
  ): CompositionDropZone | null {
    if (
      !Number.isFinite(xRatio)
      || !Number.isFinite(yRatio)
      || xRatio < 0
      || xRatio > 1
      || yRatio < 0
      || yRatio > 1
    ) return null;
    const zones = compositionDropZonesForNode(node, payload);
    const inside = zones.find((zone) => zone.side === "inside");
    if (inside) return inside;
    const distance = (zone: CompositionDropZone): number => {
      if (zone.side === "left") return xRatio;
      if (zone.side === "right") return 1 - xRatio;
      if (zone.side === "top") return yRatio;
      if (zone.side === "bottom") return 1 - yRatio;
      return Number.POSITIVE_INFINITY;
    };
    return [...zones].sort((left, right) => distance(left) - distance(right))[0] ?? null;
  }

  function compositionPointerTargetAt(
    point: ComponentPointerDragPoint,
    payload: CompositionDragPayload,
  ): { node: ResolvedComponentNode; zone: CompositionDropZone } | null {
    if (!compositionPreviewTree) return null;
    const eventTarget = document.elementFromPoint(point.clientX, point.clientY);
    if (!(eventTarget instanceof globalThis.Element)) return null;
    if (eventTarget.closest("[data-composition-controls]")) return null;
    const nodeElement = eventTarget.closest<HTMLElement>("[data-node-id]");
    const nodeId = nodeElement?.dataset.nodeId;
    if (!nodeId || !nodeElement) return null;
    const node = resolvedNodeById(compositionPreviewTree, nodeId);
    if (!node) return null;
    const rect = nodeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const zone = compositionPointerDropZone(
      node,
      (point.clientX - rect.left) / rect.width,
      (point.clientY - rect.top) / rect.height,
      payload,
    );
    return zone && compositionTargetIsValid(zone.target, payload) ? { node, zone } : null;
  }

  function compositionTargetIsValid(
    target: CompositionTarget,
    payload: CompositionDragPayload,
  ): boolean {
    if (!compositionConfig) return false;
    return planCompositionOperation({
      config: compositionConfig,
      catalog: compositionCatalog,
      payload,
      target,
    }).status === "planned";
  }

  function defaultCompositionTarget(): CompositionTarget | null {
    if (!compositionConfig) return null;
    const manifest = catalogManifest(compositionCatalog, compositionConfig.root.component);
    const insertion = deriveInsertionTargets({
      target: compositionConfig.root,
      manifest,
      parentPath: [],
      currentChildCount: childEdges(compositionConfig.root.children).length,
    })[0];
    if (!insertion) return { type: "root-replacement", path: [] };
    const metadata = manifest ? defaultChildMetadata(manifest, childEdges(compositionConfig.root.children).length) : {};
    return Object.keys(metadata).length === 0
      ? insertion
      : { ...insertion, placement: { ...insertion.placement, metadata } };
  }
  return {
    pathForNode: compositionPathForNode,
    dropZonesForNode: compositionDropZonesForNode,
    pointerDropZoneForNode: compositionPointerDropZone,
    pointerTargetAt: compositionPointerTargetAt,
    targetIsValid: compositionTargetIsValid,
    defaultTarget: defaultCompositionTarget,
  };
}
