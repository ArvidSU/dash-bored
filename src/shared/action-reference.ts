const NODE_PATH = /^root(?:\.children(?:\[\d+\]|(?:\.(?:first|second))+)?\.node)*$/;

export function interpolateActionReference(
  reference: string,
  resolveNodePath: (path: string) => string | undefined,
): string {
  if (reference.trim() === "") throw new Error("Action references must be non-empty strings.");
  let tokenCount = 0;
  const interpolated = reference.replace(/\$\{([^{}]*)\}/g, (_token, expression: string) => {
    tokenCount += 1;
    if (!NODE_PATH.test(expression)) {
      throw new Error(`Malformed component node path: ${expression || "(empty)"}`);
    }
    const nodeId = resolveNodePath(expression);
    if (nodeId === undefined) throw new Error(`Component node path does not exist: ${expression}`);
    return encodeURIComponent(nodeId);
  });
  const openingCount = (reference.match(/\$\{/g) ?? []).length;
  if (openingCount !== tokenCount || interpolated.includes("${") || /[{}]/.test(interpolated)) {
    throw new Error("Malformed component node path interpolation.");
  }
  return interpolated;
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
