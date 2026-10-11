import { useEffect, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { nodeLabel } from "../lib/virtual-root";
import { useLatestRef } from "./use-latest-ref";

/** Marks the control that toggles picking; its own clicks pass through. */
export const COMPONENT_PICKER_TOGGLE = "data-component-picker-toggle";

const PICKABLE = ".workspace [data-node-id]";

interface PickerFrame {
  node: ResolvedComponentNode;
  rect: { top: number; left: number; width: number; height: number };
}

interface PickerHit {
  element: HTMLElement;
  node: ResolvedComponentNode;
}

/**
 * Dropper mode for the header's agent control: hovering highlights the
 * innermost dashboard component and clicking it hands the node to `onPick`.
 * Shift-clicks collect several components instead (a selected one toggles
 * off) and releasing Shift hands over the selection in pick order. While
 * active, window capture listeners swallow pointer input so components never
 * react to the pick; a plain click outside a component, the context menu, or
 * Escape cancels.
 */
export function useComponentPicker(
  enabled: boolean,
  resolve: (nodeId: string) => ResolvedComponentNode | null,
  onPick: (nodes: ResolvedComponentNode[]) => void,
) {
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState<PickerFrame | null>(null);
  const [selection, setSelection] = useState<PickerFrame[]>([]);
  const resolveRef = useLatestRef(resolve);
  const onPickRef = useLatestRef(onPick);

  useEffect(() => {
    if (!enabled) setActive(false);
  }, [enabled]);

  // Install capture listeners in the same commit that exposes active mode.
  // A passive effect leaves a window where the active UI is visible but an
  // immediate Escape or component click can arrive before the picker handles it.
  useLayoutEffect(() => {
    if (!active) {
      setHover(null);
      setSelection([]);
      return;
    }
    let current: PickerHit | null = null;
    let selected: PickerHit[] = [];
    const hit = (target: EventTarget | null): PickerHit | null => {
      const element = target instanceof Element ? target.closest<HTMLElement>(PICKABLE) : null;
      const node = element?.dataset.nodeId ? resolveRef.current(element.dataset.nodeId) : null;
      return element && node ? { element, node } : null;
    };
    // A re-rendered component replaces its frame; selected nodes follow it by ID.
    const locate = (picked: PickerHit): PickerHit | null => {
      if (picked.element.isConnected) return picked;
      const element = [...document.querySelectorAll<HTMLElement>(PICKABLE)]
        .find((candidate) => candidate.dataset.nodeId === picked.node.id);
      return element ? { element, node: picked.node } : null;
    };
    const frame = ({ element, node }: PickerHit): PickerFrame => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return { node, rect: { top, left, width, height } };
    };
    const paint = () => {
      selected = selected.map((picked) => locate(picked) ?? picked);
      setSelection(selected.filter((picked) => picked.element.isConnected).map(frame));
      const hovered = current?.element.isConnected
        && !selected.some((picked) => picked.node.id === current!.node.id);
      setHover(hovered ? frame(current!) : null);
    };
    const finish = (nodes: ResolvedComponentNode[]) => {
      setActive(false);
      if (nodes.length > 0) onPickRef.current(nodes);
    };
    const accept = () => finish(selected.map((picked) => picked.node));
    const isToggle = (target: EventTarget | null) =>
      target instanceof Element && target.closest(`[${COMPONENT_PICKER_TOGGLE}]`) !== null;
    const swallow = (event: Event) => {
      if (isToggle(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (event: PointerEvent) => {
      // Shift came up while the window could not see it, such as in another app.
      if (!event.shiftKey && selected.length > 0) {
        accept();
        return;
      }
      const next = isToggle(event.target) ? null : hit(event.target);
      if (next?.element === current?.element) return;
      current = next;
      paint();
    };
    const click = (event: MouseEvent) => {
      if (isToggle(event.target)) return;
      swallow(event);
      const picked = hit(event.target);
      if (event.shiftKey) {
        // A stray Shift-click between components keeps the selection.
        if (!picked) return;
        selected = selected.some((entry) => entry.node.id === picked.node.id)
          ? selected.filter((entry) => entry.node.id !== picked.node.id)
          : [...selected, picked];
        paint();
      } else if (selected.length > 0) {
        accept();
      } else {
        finish(picked ? [picked.node] : []);
      }
    };
    const cancel = (event: Event) => {
      swallow(event);
      setActive(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel(event);
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === "Shift" && selected.length > 0) accept();
    };
    const listeners: [string, (event: never) => void][] = [
      ["pointermove", move],
      ["pointerdown", swallow],
      ["pointerup", swallow],
      ["click", click],
      ["dblclick", swallow],
      ["contextmenu", cancel],
      ["keydown", keydown],
      ["keyup", keyup],
      ["scroll", paint],
      ["resize", paint],
    ];
    for (const [type, listener] of listeners) window.addEventListener(type, listener as EventListener, true);
    document.documentElement.classList.add("component-picking");
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener as EventListener, true);
      document.documentElement.classList.remove("component-picking");
    };
  }, [active, onPickRef, resolveRef]);

  return {
    enabled,
    active,
    hover,
    selection,
    toggle: () => setActive((value) => enabled && !value),
    cancel: () => setActive(false),
  };
}

function pickerName(node: ResolvedComponentNode): string {
  return node.configName?.trim() || nodeLabel(node, false);
}

/**
 * Outlines drawn while picking: each Shift-selected component, numbered in
 * pick order, and the hovered one.
 */
export function ComponentPickerHighlight({
  hover,
  selection,
}: {
  hover: PickerFrame | null;
  selection: readonly PickerFrame[];
}): ReactNode {
  return (
    <>
      {selection.map((selected, index) => (
        <div
          key={selected.node.id}
          className="component-picker__highlight component-picker__highlight--selected"
          style={selected.rect}
          aria-hidden="true"
        >
          <span className="component-picker__label">
            <span className="component-picker__order">{index + 1}</span>
            {pickerName(selected.node)}
          </span>
        </div>
      ))}
      {hover ? (
        <div className="component-picker__highlight" style={hover.rect} aria-hidden="true">
          <span className="component-picker__label">{pickerName(hover.node)}</span>
        </div>
      ) : null}
    </>
  );
}
