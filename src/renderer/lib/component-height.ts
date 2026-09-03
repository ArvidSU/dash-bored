import type { ResolvedComponentNode } from "../../shared/contracts";
import { childNodes } from "./component-children";

export const MIN_COMPONENT_HEIGHT_PX = 56;
export const MAX_COMPONENT_HEIGHT_PX = 100_000;

const MAX_COMPONENT_HEIGHT_OVERRIDES = 2_000;

export type ComponentHeightOverrides = Record<string, number>;

export function componentRendersSurface(
  node: Pick<ResolvedComponentNode, "source" | "manifest">,
): boolean {
  return node.source !== "config" && node.manifest?.renderMode !== "layout";
}

export function normalizeComponentHeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MIN_COMPONENT_HEIGHT_PX || value > MAX_COMPONENT_HEIGHT_PX) return undefined;
  return Math.round(value);
}

export function componentHeightOverridesStorageKey(configPath: string): string {
  return `dash-bored:component-heights:${configPath}`;
}

export function parseComponentHeightOverrides(raw: string | null): ComponentHeightOverrides {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([id, value]) => id.length > 0 && id.length <= 128 && normalizeComponentHeight(value) !== undefined)
        .slice(0, MAX_COMPONENT_HEIGHT_OVERRIDES)
        .map(([id, value]) => [id, normalizeComponentHeight(value)!]),
    );
  } catch {
    return {};
  }
}

export function serializeComponentHeightOverrides(
  overrides: Readonly<ComponentHeightOverrides>,
): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(overrides)
      .filter(([, value]) => normalizeComponentHeight(value) !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_COMPONENT_HEIGHT_OVERRIDES),
  ));
}

export function collectHeightResizableNodeIds(root: ResolvedComponentNode): Set<string> {
  const ids = new Set<string>();
  function visit(node: ResolvedComponentNode): void {
    if (componentRendersSurface(node)) ids.add(node.id);
    for (const child of childNodes(node)) visit(child);
  }
  visit(root);
  return ids;
}

export function pruneComponentHeightOverrides(
  overrides: Readonly<ComponentHeightOverrides>,
  root: ResolvedComponentNode,
): ComponentHeightOverrides {
  const validIds = collectHeightResizableNodeIds(root);
  return Object.fromEntries(
    Object.entries(overrides).filter(([id]) => validIds.has(id)),
  );
}
