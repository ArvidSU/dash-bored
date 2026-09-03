import { createContext } from "react";
import type {
  ComponentCatalogItem,
  DashboardConfig,
  DashboardInsertionTarget,
  ResolvedComponentNode,
} from "../../shared/contracts";
import type { InsertionTarget, NodePath } from "./dashboard-editor";

export const COMPOSITION_COMPONENT_DRAG_TYPE = "application/x-dash-bored-component";
export const COMPOSITION_NODE_DRAG_TYPE = "application/x-dash-bored-node";

export type CompositionTarget = InsertionTarget | { type: "root-replacement"; path: [] };

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
  target: DashboardInsertionTarget | { type: "root-replacement"; path: [] };
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
  pointerDropZoneForNode: (
    node: ResolvedComponentNode,
    xRatio: number,
    yRatio: number,
    payload?: CompositionDragPayload | null,
  ) => CompositionDropZone | null;
  canDrop: (target: CompositionTarget, payload: CompositionDragPayload) => boolean;
  onNodeDragStart: (path: NodePath) => void;
  onNodeDragEnd: () => void;
  onNodePointerDragMove: (path: NodePath, point: { clientX: number; clientY: number }) => void;
  onNodePointerDrop: (path: NodePath, point: { clientX: number; clientY: number }) => void;
  onDragTarget: (nodeId: string | null, zone: CompositionDropZone | null) => void;
  onLibraryDragStart: (reference: string) => void;
  onLibraryDragEnd: () => void;
  onDrop: (target: CompositionTarget, payload: CompositionDragPayload) => void;
}

export const CompositionContext = createContext<CompositionContextValue | null>(null);
