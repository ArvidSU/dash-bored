import { ANIMATION_REFERENCE_PATTERN } from "./animations";

/** Upper bound on the reason an attention request shows beside its notice. */
export const MAX_ATTENTION_MESSAGE_CHARS = 200;

/** `reveal:<node>` may name one item, by its stable ID, to highlight after revealing. */
export const REVEAL_ACTION_ARGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { item: { type: "string", minLength: 1, maxLength: 512 } },
};

/**
 * `attention:<node>` may pick an animation, give a short reason, and name one
 * item inside the node to animate instead of the whole frame.
 */
export const ATTENTION_ACTION_ARGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    animation: { type: "string", pattern: ANIMATION_REFERENCE_PATTERN, maxLength: 200 },
    message: { type: "string", minLength: 1, maxLength: MAX_ATTENTION_MESSAGE_CHARS },
    item: { type: "string", minLength: 1, maxLength: 512 },
  },
};

/**
 * `notify:<node>` raises a notification about one component, or one item in
 * it, with a short message the user decides on (Show or Dismiss).
 */
export const NOTIFY_ACTION_ARGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: MAX_ATTENTION_MESSAGE_CHARS },
    item: { type: "string", minLength: 1, maxLength: 512 },
  },
};

const SINGLE_NODE_VERBS = new Set(["focus", "process", "reveal", "attention", "notify"]);

/** Return the stable node ID carried by a node-targeting action reference. */
export function parseActionReferenceNodeId(reference: string): string | undefined {
  const parts = reference.split(":");
  const targetIndex = SINGLE_NODE_VERBS.has(parts[0]!)
    ? parts.length === 2 ? 1 : -1
    : parts[0] === "component" && parts.length === 3 ? 1 : -1;
  if (targetIndex < 0 || !parts[targetIndex]) return undefined;
  try {
    const id = decodeURIComponent(parts[targetIndex]!);
    return id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

export function parseSelectionActionReference(reference: string): { containerId: string; childId: string } | undefined {
  const match = /^select:([^/]+)\/([^/]+)$/.exec(reference);
  if (!match) return undefined;
  try {
    const containerId = decodeURIComponent(match[1]!);
    const childId = decodeURIComponent(match[2]!);
    return containerId.trim() && childId.trim() ? { containerId, childId } : undefined;
  } catch { return undefined; }
}

export function parseComponentActionReference(reference: string): { nodeId: string; actionId: string } | undefined {
  const parts = reference.split(":");
  if (parts.length !== 3 || parts[0] !== "component") return undefined;
  try {
    const nodeId = decodeURIComponent(parts[1]!);
    const actionId = decodeURIComponent(parts[2]!);
    return nodeId.trim() && actionId.trim() ? { nodeId, actionId } : undefined;
  } catch {
    return undefined;
  }
}

/** Remap the node-bearing segment of a stable action reference. */
export function remapActionReferenceNode(
  reference: string,
  remap: (nodeId: string) => string | undefined,
): string {
  const parts = reference.split(":");
  if (SINGLE_NODE_VERBS.has(parts[0]!) && parts.length === 2) {
    return remapPart(parts, 1, remap);
  }
  const selection = parseSelectionActionReference(reference);
  if (selection) {
    const containerId = remap(selection.containerId) ?? selection.containerId;
    const childId = remap(selection.childId) ?? selection.childId;
    return `select:${encodeURIComponent(containerId)}/${encodeURIComponent(childId)}`;
  }
  if (parts[0] === "component" && parts.length === 3) {
    return remapPart(parts, 1, remap);
  }
  return reference;
}

function remapPart(
  parts: string[],
  index: number,
  remap: (nodeId: string) => string | undefined,
): string {
  try {
    const current = decodeURIComponent(parts[index]!);
    const next = remap(current);
    if (next === undefined) return parts.join(":");
    parts[index] = encodeURIComponent(next);
    return parts.join(":");
  } catch {
    return parts.join(":");
  }
}

export function componentActionReference(nodeId: string, localActionId: string): string {
  return `component:${encodeURIComponent(nodeId)}:${encodeURIComponent(localActionId)}`;
}

/** True when a `focus:` action reference names the given node. */
export function isFocusOfNode(reference: string, nodeId: string | null): boolean {
  return nodeId !== null && reference.startsWith("focus:") && parseActionReferenceNodeId(reference) === nodeId;
}

/**
 * Percent-encodes a raw node ID that contains `:` (linked namespaces use `::`)
 * so the reference splits into the right segments. Encoded and colon-free
 * references, `select:`, and everything else pass through unchanged.
 */
export function normalizeActionReference(reference: string): string {
  const parts = reference.split(":");
  if (SINGLE_NODE_VERBS.has(parts[0]!) && parts.length > 2) {
    return `${parts[0]}:${encodeURIComponent(parts.slice(1).join(":"))}`;
  }
  if (parts[0] === "component" && parts.length > 3) {
    return `component:${encodeURIComponent(parts.slice(1, -1).join(":"))}:${parts.at(-1)}`;
  }
  return reference;
}
