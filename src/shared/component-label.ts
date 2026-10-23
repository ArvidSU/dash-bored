import type { ResolvedComponentNode } from "./contracts";

/** Props are opaque except for display bindings explicitly declared by their author. */
export function declaredComponentLabel(node: Pick<ResolvedComponentNode, "props" | "manifest">): string | undefined {
  for (const key of node.manifest?.labelProps ?? []) {
    const value = node.props[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
