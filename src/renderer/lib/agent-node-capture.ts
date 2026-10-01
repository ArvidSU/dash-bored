import type { AgentNodeMeasurement } from "../../shared/agent-control";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NodeCaptureHooks {
  /** Expands and selects whatever hides the node, as `reveal:<node>` does. */
  reveal(nodeId: string): Promise<void>;
  /** Captures the user's presentation state and returns a function that restores it. */
  snapshotView(): () => void;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

function nodeElement(nodeId: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find((element) => element.dataset.nodeId === nodeId);
}

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function intersect(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/** The part of the node a person could see: clipped by the viewport and by every clipping ancestor. */
function visibleBox(element: HTMLElement): Box {
  let box = intersect(toBox(element.getBoundingClientRect()), {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth,
    bottom: window.innerHeight,
  });
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if ([style.overflowX, style.overflowY].every((value) => value === "visible")) continue;
    const rect = ancestor.getBoundingClientRect();
    box = intersect(box, {
      left: rect.left + ancestor.clientLeft,
      top: rect.top + ancestor.clientTop,
      right: rect.left + ancestor.clientLeft + ancestor.clientWidth,
      bottom: rect.top + ancestor.clientTop + ancestor.clientHeight,
    });
  }
  return box;
}

function sameBox(a: Box, b: Box): boolean {
  return (["left", "top", "right", "bottom"] as const).every((side) => Math.abs(a[side] - b[side]) < 0.5);
}

/** Resolves once the node stops moving (smooth scrolls and mount animations finish). */
async function settledBox(element: HTMLElement, maxFrames = 40): Promise<Box> {
  let previous = visibleBox(element);
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await nextFrame();
    const current = visibleBox(element);
    if (sameBox(previous, current)) return current;
    previous = current;
  }
  return previous;
}

interface ScrollPosition {
  element: Element;
  left: number;
  top: number;
}

function scrollPositions(): ScrollPosition[] {
  const scrolling = document.scrollingElement;
  return [...document.querySelectorAll("*"), ...(scrolling ? [scrolling] : [])]
    .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
    .map((element) => ({ element, left: element.scrollLeft, top: element.scrollTop }));
}

function sameScroll(a: ScrollPosition[], b: ScrollPosition[]): boolean {
  const key = (positions: ScrollPosition[]) => new Map(positions.map(({ element, left, top }) => [element, `${left},${top}`]));
  const [first, second] = [key(a), key(b)];
  return first.size === second.size && [...first].every(([element, value]) => second.get(element) === value);
}

function restoreScroll(positions: ScrollPosition[]): void {
  for (const { element, left, top } of positions) {
    if (element.isConnected) element.scrollTo({ left, top, behavior: "instant" });
  }
}

/**
 * Measures a node for an agent screenshot while keeping the user's view intact.
 * An already visible node is measured where it stands. Otherwise the session
 * reveals it (when unmounted) and scrolls it into view without animation, and
 * `end` restores presentation state and scroll positions.
 */
export class NodeCaptureSession {
  private restoreView: (() => void) | null = null;
  private scrolls: ScrollPosition[] | null = null;

  async begin(nodeId: string, hooks: NodeCaptureHooks): Promise<AgentNodeMeasurement> {
    await this.end();
    this.scrolls = scrollPositions();
    try {
      let element = nodeElement(nodeId);
      let revealed = false;
      if (!element) {
        this.restoreView = hooks.snapshotView();
        await hooks.reveal(nodeId);
        revealed = true;
        for (let frame = 0; frame < 30 && !element; frame += 1) {
          await nextFrame();
          element = nodeElement(nodeId);
        }
        if (!element) throw new Error(`Node ${nodeId} is not shown after revealing it; it may not exist or may be hidden by the current focus.`);
        await frames(3);
      }
      const full = element.getBoundingClientRect();
      let box = await settledBox(element);
      let scrolled = false;
      const fits = (visible: Box) => visible.right - visible.left >= full.width - 1 && visible.bottom - visible.top >= full.height - 1;
      if (!fits(box)) {
        const before = scrollPositions();
        // A node taller than the view cannot fit; show its top.
        element.scrollIntoView({ block: full.height > window.innerHeight ? "start" : "nearest", inline: "nearest", behavior: "instant" });
        box = await settledBox(element);
        scrolled = !sameScroll(before, scrollPositions());
      }
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      if (width <= 0 || height <= 0) throw new Error(`Node ${nodeId} has no visible area.`);
      return {
        nodeId,
        rect: { x: box.left, y: box.top, width, height },
        fullWidth: Math.round(full.width),
        fullHeight: Math.round(full.height),
        truncated: !fits(box),
        viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        changes: { revealed, scrolled },
      };
    } catch (error) {
      await this.end();
      throw error;
    }
  }

  async end(): Promise<void> {
    const restoreView = this.restoreView;
    const scrolls = this.scrolls;
    this.restoreView = null;
    this.scrolls = null;
    if (restoreView) {
      restoreView();
      await frames(3);
    }
    if (scrolls) {
      restoreScroll(scrolls);
      await frames(1);
    }
  }
}
