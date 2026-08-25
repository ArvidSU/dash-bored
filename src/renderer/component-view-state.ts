import type { ResolvedComponentNode } from "../shared/contracts";

const MAX_COLLAPSED_COMPONENTS = 2_000;

export function collapsedComponentsStorageKey(configPath: string): string {
  return `dash-bored:collapsed-components:${configPath}`;
}

export function parseCollapsedComponentIds(raw: string | null): Set<string> {
  if (raw === null) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, MAX_COLLAPSED_COMPONENTS),
    );
  } catch {
    return new Set();
  }
}

export function serializeCollapsedComponentIds(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort().slice(0, MAX_COLLAPSED_COMPONENTS));
}

export function countComponentDescendants(node: ResolvedComponentNode): number {
  return Object.values(node.slots).reduce(
    (count, children) => count + children.reduce(
      (childCount, child) => childCount + 1 + countComponentDescendants(child),
      0,
    ),
    0,
  );
}

export function collectComponentNodeIds(node: ResolvedComponentNode): Set<string> {
  const ids = new Set<string>();

  function visit(current: ResolvedComponentNode): void {
    ids.add(current.id);
    for (const children of Object.values(current.slots)) {
      for (const child of children) visit(child);
    }
  }

  visit(node);
  return ids;
}
