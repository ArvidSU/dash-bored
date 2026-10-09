import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { nodeLabel } from "../lib/virtual-root";
import { useLatestRef } from "./use-latest-ref";

/** Marks the control that toggles picking; its own clicks pass through. */
export const COMPONENT_PICKER_TOGGLE = "data-component-picker-toggle";

interface PickerHover {
  node: ResolvedComponentNode;
  rect: { top: number; left: number; width: number; height: number };
}

/**
 * Dropper mode for the header's agent control: hovering highlights the
 * innermost dashboard component and clicking it hands the node to `onPick`.
 * While active, window capture listeners swallow pointer input so components
 * never react to the pick; any click outside a component, the context menu,
 * or Escape cancels.
 */
export function useComponentPicker(
  enabled: boolean,
  resolve: (nodeId: string) => ResolvedComponentNode | null,
  onPick: (node: ResolvedComponentNode) => void,
) {
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState<PickerHover | null>(null);
  const resolveRef = useLatestRef(resolve);
  const onPickRef = useLatestRef(onPick);

  useEffect(() => {
    if (!enabled) setActive(false);
  }, [enabled]);

  useEffect(() => {
    if (!active) {
      setHover(null);
      return;
    }
    let current: { element: HTMLElement; node: ResolvedComponentNode } | null = null;
    const hit = (target: EventTarget | null) => {
      const element = target instanceof Element
        ? target.closest<HTMLElement>(".workspace [data-node-id]")
        : null;
      const node = element?.dataset.nodeId ? resolveRef.current(element.dataset.nodeId) : null;
      return element && node ? { element, node } : null;
    };
    const paint = () => {
      if (!current?.element.isConnected) {
        setHover(null);
        return;
      }
      const { top, left, width, height } = current.element.getBoundingClientRect();
      setHover({ node: current.node, rect: { top, left, width, height } });
    };
    const isToggle = (target: EventTarget | null) =>
      target instanceof Element && target.closest(`[${COMPONENT_PICKER_TOGGLE}]`) !== null;
    const swallow = (event: Event) => {
      if (isToggle(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (event: PointerEvent) => {
      const next = isToggle(event.target) ? null : hit(event.target);
      if (next?.element === current?.element) return;
      current = next;
      paint();
    };
    const click = (event: MouseEvent) => {
      if (isToggle(event.target)) return;
      swallow(event);
      const picked = hit(event.target);
      setActive(false);
      if (picked) onPickRef.current(picked.node);
    };
    const cancel = (event: Event) => {
      swallow(event);
      setActive(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel(event);
    };
    const listeners: [string, (event: never) => void][] = [
      ["pointermove", move],
      ["pointerdown", swallow],
      ["pointerup", swallow],
      ["click", click],
      ["dblclick", swallow],
      ["contextmenu", cancel],
      ["keydown", key],
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
    toggle: () => setActive((value) => enabled && !value),
    cancel: () => setActive(false),
  };
}

/** The outline drawn over the hovered component while picking. */
export function ComponentPickerHighlight({ hover }: { hover: PickerHover | null }): ReactNode {
  if (!hover) return null;
  const name = hover.node.configName?.trim() || nodeLabel(hover.node, false);
  return (
    <div className="component-picker__highlight" style={hover.rect} aria-hidden="true">
      <span className="component-picker__label">{name}</span>
    </div>
  );
}
