/** Return the stable node ID carried by a node-targeting action reference. */
export function parseActionReferenceNodeId(reference: string): string | undefined {
  const parts = reference.split(":");
  const targetIndex = parts[0] === "focus" || parts[0] === "process"
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
  if ((parts[0] === "focus" || parts[0] === "process") && parts.length === 2) {
    return remapPart(parts, 1, remap);
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
