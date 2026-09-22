import { forwardRef } from "react";
import type { CompositionDragPayload } from "./composition-context";

export type CompositionDragChipState = "target" | "none" | "remove";

/**
 * Cursor-following label for the payload in hand. Position and target state
 * are written to the element directly on each pointer frame (see
 * `positionCompositionDragChip`) so moving the pointer never re-renders React.
 * It is hidden until its first positioned frame and never takes pointer input,
 * so `elementFromPoint` hit-testing sees through it.
 */
export const CompositionDragChip = forwardRef<HTMLDivElement, {
  dragging: CompositionDragPayload;
  label: string;
}>(function CompositionDragChip({ dragging, label }, ref) {
  return (
    <div className="composition-drag-chip" ref={ref} aria-hidden="true">
      <span className="composition-drag-chip__mode">{dragging.type === "node" ? "Moving" : "Adding"}</span>
      <strong>{label}</strong>
      <span className="composition-drag-chip__status composition-drag-chip__status--none">No drop target</span>
      <span className="composition-drag-chip__status composition-drag-chip__status--remove">Release to remove</span>
    </div>
  );
});

const CHIP_POINTER_OFFSET_PX = 14;

export function positionCompositionDragChip(
  element: HTMLElement | null,
  point: { clientX: number; clientY: number },
  state: CompositionDragChipState,
): void {
  if (!element) return;
  element.style.transform = `translate3d(${point.clientX + CHIP_POINTER_OFFSET_PX}px, ${point.clientY + CHIP_POINTER_OFFSET_PX}px, 0)`;
  if (element.dataset.state !== state) element.dataset.state = state;
}
