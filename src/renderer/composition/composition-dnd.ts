import {
  COMPOSITION_COMPONENT_DRAG_TYPE,
  COMPOSITION_NODE_DRAG_TYPE,
  type CompositionDropZone,
  type CompositionTarget,
  type CompositionDragPayload,
} from "./composition-context";
import type { NodePath } from "./dashboard-editor";

export function compositionPayloadFromTransfer(
  dataTransfer: Pick<DataTransfer, "types" | "getData">,
): CompositionDragPayload | null {
  const type = dataTransfer.types.includes(COMPOSITION_COMPONENT_DRAG_TYPE)
    ? COMPOSITION_COMPONENT_DRAG_TYPE
    : dataTransfer.types.includes(COMPOSITION_NODE_DRAG_TYPE)
      ? COMPOSITION_NODE_DRAG_TYPE
      : null;
  if (!type) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(type));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as { type?: unknown; reference?: unknown; path?: unknown };
    if (value.type === "component" && typeof value.reference === "string") {
      return { type: "component", reference: value.reference };
    }
    if (value.type === "node" && Array.isArray(value.path)) {
      return { type: "node", path: value.path as NodePath };
    }
  } catch {
    // Drag data is supplied by the browser and may be malformed or stale.
  }
  return null;
}

export function compositionPayloadFromDragEvent(
  dataTransfer: Pick<DataTransfer, "types" | "getData">,
  dragging: CompositionDragPayload | null,
): CompositionDragPayload | null {
  // Some WebKit/Electrobun versions expose custom drag types during
  // dragstart but omit them again during dragover/drop. The renderer state is
  // already the authoritative payload for a drag that began in this app, so
  // retain it as the safe fallback while still accepting interoperable drops.
  return compositionPayloadFromTransfer(dataTransfer) ?? dragging;
}

/** Keep presentation and hit-testing limited to targets accepted by the active payload. */
export function compatibleCompositionDropZones(
  zones: readonly CompositionDropZone[],
  payload: CompositionDragPayload | null | undefined,
  canDrop: (target: CompositionTarget, payload: CompositionDragPayload) => boolean,
): CompositionDropZone[] {
  return payload == null ? [...zones] : zones.filter((zone) => canDrop(zone.target, payload));
}
