import { useEffect } from "react";
import type { WindowDragRect, WindowDragRegions } from "../../shared/window-drag";
import { host } from "../lib/rpc-client";

const CONTROLS = "button, a, input, textarea, select, summary, [tabindex], [contenteditable='true'], [data-window-no-drag]";

export function measureWindowDragRegions(): WindowDragRegions {
  const regions: WindowDragRegions = { width: window.innerWidth, height: window.innerHeight, drag: [], exclude: [] };
  // Modal backdrops cover shell chrome too. Never catch their clicks in a
  // native surface above the webview, including while a dialog is closing.
  if (document.querySelector("[aria-modal='true']")) return regions;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (element: Element) => {
    let computed = styles.get(element);
    if (!computed) { computed = getComputedStyle(element); styles.set(element, computed); }
    return computed;
  };
  const rects = (element: Element): WindowDragRect[] => {
    if (style(element).visibility !== "visible") return [];
    let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
    // getClientRects includes content clipped by scrolling ancestors. A long
    // sidebar tree must not project invisible controls over the header.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const computed = style(parent);
      const box = parent.getBoundingClientRect();
      if (computed.overflowX !== "visible") { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (computed.overflowY !== "visible") { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    return Array.from(element.getClientRects())
      .map((rect) => ({ x: Math.max(left, rect.left), y: Math.max(top, rect.top),
        width: Math.min(right, rect.right) - Math.max(left, rect.left),
        height: Math.min(bottom, rect.bottom) - Math.max(top, rect.top) }))
      .filter((rect) => rect.width > 0 && rect.height > 0);
  };
  for (const surface of document.querySelectorAll("[data-window-drag]")) {
    regions.drag.push(...rects(surface));
    for (const control of surface.querySelectorAll(CONTROLS)) {
      // One exclusion per project/tree or action row, independent of how many
      // nested buttons it contains.
      const ancestor = control.parentElement?.closest(CONTROLS);
      if (!ancestor || !surface.contains(ancestor)) regions.exclude.push(...rects(control));
    }
  }
  // Nonmodal drawers and menus can cover shell chrome while leaving the rest
  // of the window draggable.
  for (const overlay of document.querySelectorAll("[role='dialog'], [role='menu']")) regions.exclude.push(...rects(overlay));
  return regions;
}

export function useWindowDrag(): void {
  useEffect(() => {
    let frame = 0;
    let previous = "";
    const observed = new Set<Element>();
    const sync = () => {
      frame = 0;
      for (const element of observed) {
        if (!element.isConnected) { resize.unobserve(element); observed.delete(element); }
      }
      for (const element of document.querySelectorAll("[data-window-drag], [data-window-no-drag]")) {
        if (!observed.has(element)) { resize.observe(element); observed.add(element); }
      }
      const regions = measureWindowDragRegions();
      const signature = JSON.stringify(regions);
      if (signature !== previous) {
        previous = signature;
        host.setWindowDragRegions(regions);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-modal", "open"] });
    // Observe the shell as it appears after boot and its action row as labels
    // change width. ResizeObserver follows sidebar transitions.
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      host.setWindowDragRegions({ width: window.innerWidth, height: window.innerHeight, drag: [], exclude: [] });
    };
  }, []);
}
