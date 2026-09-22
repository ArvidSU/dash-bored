import type { ResolvedComponentNode } from "../../shared/contracts";
import { childNodes } from "./component-children";

const MAX_COLLAPSED_COMPONENTS = 2_000;
const MAX_SELECTED_CHILDREN = 2_000;

export type ChildSelections = Readonly<Record<string, string>>;

export function childSelectionsStorageKey(configPath: string): string {
  return `dash-bored:selected-children:${configPath}`;
}

export function parseChildSelections(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter((entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0)
      .slice(0, MAX_SELECTED_CHILDREN));
  } catch { return {}; }
}

export function serializeChildSelections(selections: ChildSelections): string {
  return JSON.stringify(Object.fromEntries(Object.entries(selections).sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_SELECTED_CHILDREN)));
}

export function pruneChildSelections(selections: ChildSelections, node: ResolvedComponentNode): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(current: ResolvedComponentNode): void {
    const definition = current.manifest?.children;
    if (definition?.select === "single" && Array.isArray(current.children)) {
      const childIds = new Set(current.children.map((edge) => edge.node.id));
      const selected = selections[current.id];
      if (selected && childIds.has(selected)) result[current.id] = selected;
    }
    for (const edge of Array.isArray(current.children) ? current.children : current.children ? layoutEdges(current.children) : []) visit(edge.node);
  }
  visit(node);
  return result;
}

function layoutEdges(children: Exclude<ResolvedComponentNode["children"], unknown[] | undefined>) {
  if ("node" in children) return [children];
  return [...layoutEdges(children.first), ...layoutEdges(children.second)];
}

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
  return childNodes(node).reduce(
    (count, child) => count + 1 + countComponentDescendants(child),
    0,
  );
}

export function collectComponentNodeIds(node: ResolvedComponentNode): Set<string> {
  const ids = new Set<string>();

  function visit(current: ResolvedComponentNode): void {
    ids.add(current.id);
    for (const child of childNodes(current)) visit(child);
  }

  visit(node);
  return ids;
}
