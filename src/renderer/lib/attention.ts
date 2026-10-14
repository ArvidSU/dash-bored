import { MAX_ATTENTION_MESSAGE_CHARS } from "../../shared/action-reference";
import {
  BUILTIN_ANIMATIONS,
  builtinAnimation,
  DEFAULT_ANIMATION_REFERENCE,
  hexToRgbTriple,
  isAnimationReference,
  playableAnimation,
  type AnimationManifest,
} from "../../shared/animations";
import type { ComponentActionOption, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { PaletteAction } from "./actions";
import { childNodes } from "./component-children";
import { nodeFrame, revealScrollBehavior } from "./reveal-item";
import { dashboardNodeEntries, dashboardNodeOptionDescription } from "./virtual-root";

export interface AttentionRequest {
  animation?: string;
  message?: string;
  item?: string;
}

/** Read `attention:<node>` arguments; anything outside the declared shape is refused. */
export function attentionArguments(args: Record<string, unknown> | undefined): AttentionRequest {
  const request: AttentionRequest = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === "animation" && typeof value === "string" && isAnimationReference(value)) request.animation = value;
    else if (key === "message" && typeof value === "string" && value.trim() && value.length <= MAX_ATTENTION_MESSAGE_CHARS) request.message = value.trim();
    else if (key === "item" && typeof value === "string" && value.trim()) request.item = value;
    else {
      throw new Error(`attention accepts only { animation?: builtin:<id> | global:<name> | ./animations/<name>, message?: text of at most ${MAX_ATTENTION_MESSAGE_CHARS} characters, item?: stable item ID }.`);
    }
  }
  return request;
}

function findNode(tree: ResolvedComponentNode | null | undefined, nodeId: string): ResolvedComponentNode | undefined {
  if (!tree) return undefined;
  if (tree.id === nodeId) return tree;
  for (const child of childNodes(tree)) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Pick the manifest to play. An explicit animation resolves in the bundle of
 * the node that asked for it and fails loudly; the dashboard's
 * `attentionAnimation` default falls back to the built-in default, like a theme.
 */
export async function loadAttentionAnimation(
  snapshot: Pick<ProjectSnapshot, "config" | "tree">,
  requested: string | undefined,
  callerNodeId: string | undefined,
  read: (reference: string, configPath?: string) => Promise<AnimationManifest>,
): Promise<AnimationManifest> {
  const resolve = async (reference: string, configPath?: string): Promise<AnimationManifest> => {
    const builtin = builtinAnimation(reference);
    if (builtin) return builtin;
    if (reference.startsWith("builtin:")) {
      throw new Error(`${reference} is not a built-in animation; built-ins are ${BUILTIN_ANIMATIONS.map((item) => item.reference).join(", ")}.`);
    }
    return read(reference, configPath);
  };
  if (requested !== undefined) return resolve(requested, findNode(snapshot.tree, callerNodeId ?? "")?.sourceConfigPath);
  const fallback = snapshot.config?.attentionAnimation;
  if (fallback) {
    try {
      return await resolve(fallback);
    } catch (error) {
      console.warn(`attentionAnimation ${fallback} is unavailable; playing ${DEFAULT_ANIMATION_REFERENCE}.`, error);
    }
  }
  return builtinAnimation(DEFAULT_ANIMATION_REFERENCE)!;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Waits a few frames for a just-revealed node, or one of its items, to mount. */
async function attentionTarget(nodeId: string, itemId: string | undefined, maxFrames = 30): Promise<HTMLElement> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await nextFrame();
    const node = nodeFrame(nodeId);
    if (!node) continue;
    if (itemId === undefined) return node;
    const item = [...node.querySelectorAll<HTMLElement>("[data-item-id]")].find((element) => element.dataset.itemId === itemId);
    if (item) return item;
  }
  throw new Error(itemId === undefined
    ? `${nodeId} is not shown in the active dashboard.`
    : `Item ${itemId} is not shown in ${nodeId}; it may be filtered out or removed.`);
}

/** Resolves once the element stops moving, so the animation starts where the user looks. */
async function settled(element: HTMLElement, timeoutMs = 700): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let previous = element.getBoundingClientRect().top;
  let still = 0;
  while (still < 3 && performance.now() < deadline) {
    await nextFrame();
    const top = element.getBoundingClientRect().top;
    still = Math.abs(top - previous) < 0.5 ? still + 1 : 0;
    previous = top;
  }
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Frames are transparent wrappers; the card a user sees is drawn inside. Use
 * the corners of the first descendant that fills the frame so the halo hugs it.
 */
function surfaceRadius(element: HTMLElement): string | undefined {
  const own = getComputedStyle(element).borderRadius;
  if (own && own !== "0px") return undefined;
  const bounds = element.getBoundingClientRect();
  const fills = (rect: DOMRect) => Math.abs(rect.left - bounds.left) < 3 && Math.abs(rect.right - bounds.right) < 3
    && Math.abs(rect.top - bounds.top) < 3 && Math.abs(rect.bottom - bounds.bottom) < 3;
  for (const candidate of [...element.querySelectorAll<HTMLElement>("*")].slice(0, 60)) {
    const radius = getComputedStyle(candidate).borderRadius;
    if (radius && radius !== "0px" && fills(candidate.getBoundingClientRect())) return radius;
  }
  return undefined;
}

const playing = new WeakMap<Element, Animation>();

/** Plays a manifest on one element, replacing any attention animation already on it. */
export function playAttention(element: HTMLElement, manifest: AnimationManifest): Animation {
  playing.get(element)?.cancel();
  const token = getComputedStyle(document.documentElement).getPropertyValue(`--${manifest.color ?? "accent"}`);
  const animation = playableAnimation(manifest, {
    reducedMotion: reducedMotion(),
    glowRgb: hexToRgbTriple(token) ?? "128, 160, 255",
    baseShadow: getComputedStyle(element).boxShadow,
    radius: surfaceRadius(element),
  });
  const running = element.animate(animation.keyframes, animation.timing);
  playing.set(element, running);
  element.dataset.attention = "true";
  const finish = () => {
    if (playing.get(element) !== running) return;
    playing.delete(element);
    delete element.dataset.attention;
  };
  running.addEventListener("finish", finish);
  running.addEventListener("cancel", finish);
  return running;
}

/**
 * True when the window paints a frame within `ms`. Hidden windows do not; the
 * bound leaves room for the long frame that mounts a newly revealed tab.
 */
function rendering(ms = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), ms);
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A window that is not rendering keeps only its latest attention request. */
let pendingFrame: number | null = null;

/**
 * After a reveal, scroll the node (or item) into view and play; `onPlay` runs
 * when it starts. A window that renders no frames would play unseen, so the
 * request waits for the next frame it paints and the action resolves without it.
 */
export async function requestAttention(
  nodeId: string,
  manifest: AnimationManifest,
  options: { item?: string; onPlay?(): void } = {},
): Promise<void> {
  const attend = async () => {
    const target = await attentionTarget(nodeId, options.item);
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: revealScrollBehavior() });
    await settled(target);
    if (!target.isConnected) return;
    playAttention(target, manifest);
    options.onPlay?.();
  };
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
  pendingFrame = null;
  if (await rendering()) return attend();
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    void attend().catch((error) => console.warn("A deferred attention request could not play.", error));
  });
}

export function buildAttentionActions(
  snapshot: ProjectSnapshot | null,
  attend: (nodeId: string, request: AttentionRequest, callerNodeId?: string) => Promise<void>,
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  const entries = dashboardNodeEntries(snapshot.tree);
  const actions = entries.map(({ node, label }): PaletteAction => ({
    id: `attention:${encodeURIComponent(node.id)}`,
    reference: `attention:${encodeURIComponent(node.id)}`,
    parentActionId: "project:attention",
    label: `Draw attention to ${label}`,
    description: `Reveal ${label} and animate it; arguments pick the animation, add a message, or target one item.`,
    keywords: ["attention", "animate", "shake", "bounce", node.id, node.component, label],
    group: "Dashboard presentation",
    source: node.id,
    enabled: true,
    run: (_selections, args, callerNodeId) => attend(node.id, attentionArguments(args), callerNodeId),
  }));
  const fallback = snapshot.config?.attentionAnimation ?? DEFAULT_ANIMATION_REFERENCE;
  const animations: ComponentActionOption[] = (snapshot.animationCatalog ?? BUILTIN_ANIMATIONS)
    .filter((item) => item.manifest)
    .map((item) => ({
      value: item.reference,
      label: item.reference === fallback ? `${item.name} (default)` : item.name,
      description: [item.reference, item.manifest?.description].filter(Boolean).join(" · "),
    }))
    .sort((left, right) => Number(right.value === fallback) - Number(left.value === fallback));
  return [{
    id: "project:attention",
    label: "Draw attention to component",
    description: "Reveal a component and play an attention animation on it; useful to preview animations.",
    keywords: ["attention", "animate", "animation", "shake", "bounce"],
    group: "Dashboard presentation",
    enabled: true,
    choices: [
      {
        id: "node",
        label: "Draw attention to component",
        options: entries.map((entry) => ({ value: entry.node.id, label: entry.label, description: dashboardNodeOptionDescription(entry) })),
      },
      ...(animations.length > 0 ? [{ id: "animation", label: "Animation", options: animations }] : []),
    ],
    run: (selections) => {
      if (!selections?.node || !actions.some((action) => action.source === selections.node)) {
        throw new Error("Choose an available component to draw attention to.");
      }
      return attend(selections.node, selections.animation ? { animation: selections.animation } : {});
    },
  } satisfies PaletteAction, ...actions];
}
