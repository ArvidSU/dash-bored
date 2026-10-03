import { createContext } from "react";
import type { ComponentCatalogItem, DashboardConfig, ResolvedComponentNode } from "../../shared/contracts";
import type { DashboardRootReplacementTarget, InsertionTarget, NodePath } from "./dashboard-editor";

export type CompositionTarget = InsertionTarget | DashboardRootReplacementTarget;

export type CompositionDragPayload =
  | { type: "component"; reference: string }
  | { type: "node"; path: NodePath };

export interface CompositionPointerState {
  nodeId: string | null;
  /** The one compatible insertion boundary currently advertised to the user. */
  zoneId: string | null;
  clientX: number;
  clientY: number;
}

export interface CompositionDropTarget {
  id: string;
  label: string;
  target: CompositionTarget;
}

export type CompositionDropZoneSide = "left" | "right" | "top" | "bottom" | "inside";

export interface CompositionDropZone extends CompositionDropTarget {
  side: CompositionDropZoneSide;
}

export interface CompositionContextValue {
  active: boolean;
  dragging: CompositionDragPayload | null;
  pointer: CompositionPointerState | null;
  config: DashboardConfig;
  catalog: readonly ComponentCatalogItem[];
  pathForNode: (node: ResolvedComponentNode) => NodePath | null;
  dropZonesForNode: (
    node: ResolvedComponentNode,
    payload?: CompositionDragPayload | null,
  ) => readonly CompositionDropZone[];
  onNodeDragStart: (path: NodePath) => void;
  onNodeDragEnd: () => void;
  onNodePointerDragMove: (path: NodePath, point: { clientX: number; clientY: number }) => void;
  onNodePointerDrop: (path: NodePath, point: { clientX: number; clientY: number }) => void;
  onMoveSibling: (path: NodePath, direction: "previous" | "next") => void;
}

export const CompositionContext = createContext<CompositionContextValue | null>(null);
