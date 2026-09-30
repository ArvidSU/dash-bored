/** How long a revealed item keeps its highlight; keyboard focus stays on it. */
export const REVEAL_HIGHLIGHT_MS = 2400;

/** Smooth scrolling is motion too: honour reduced motion. */
export function revealScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function nodeFrame(nodeId: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find((element) => element.dataset.nodeId === nodeId);
}

/**
 * After a reveal mounts the node, find one of its items by stable ID, scroll it
 * into view, move keyboard focus to it, and mark it briefly. Items are any
 * elements that carry `data-item-id` inside the node's frame.
 */
export async function highlightRevealedItem(nodeId: string, itemId: string, maxFrames = 30): Promise<void> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await nextFrame();
    const item = [...nodeFrame(nodeId)?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []]
      .find((element) => element.dataset.itemId === itemId);
    if (!item) continue;
    item.scrollIntoView({ block: "center", inline: "nearest", behavior: revealScrollBehavior() });
    if (!item.hasAttribute("tabindex")) item.setAttribute("tabindex", "-1");
    item.focus({ preventScroll: true });
    item.dataset.revealed = "true";
    window.setTimeout(() => { delete item.dataset.revealed; }, REVEAL_HIGHLIGHT_MS);
    return;
  }
  throw new Error(`Item ${itemId} is not shown in ${nodeId}; it may be filtered out or removed.`);
}
