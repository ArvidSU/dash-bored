import type { ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { PaletteAction } from "./actions";
import { childNodes } from "./component-children";
import { selectedChildId } from "./component-view-state";
import { nodeLabel } from "./virtual-root";

function visit(node: ResolvedComponentNode, callback: (node: ResolvedComponentNode) => void): void {
  callback(node);
  for (const child of childNodes(node)) visit(child, callback);
}

export function buildSelectionActions(
  snapshot: ProjectSnapshot | null,
  selections: Readonly<Record<string, string>>,
  selectChild: (containerId: string, childId: string) => void,
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  const actions: PaletteAction[] = [];
  visit(snapshot.tree, (container) => {
    const definition = container.manifest?.children;
    if (definition?.select !== "single" || !Array.isArray(container.children)) return;
    const selected = selectedChildId(container, selections);
    for (const edge of container.children) {
      const child = edge.node;
      const label = nodeLabel(child, false);
      const id = `select:${encodeURIComponent(container.id)}/${encodeURIComponent(child.id)}`;
      actions.push({
        id,
        reference: id,
        label: `Select ${label}`,
        description: `Show ${label} in ${nodeLabel(container, false)}.`,
        keywords: ["select", "panel", container.id, child.id, label],
        group: "Dashboard presentation",
        source: child.id,
        active: selected === child.id,
        enabled: selected !== child.id,
        ...(selected === child.id ? { disabledReason: "This child is already selected." } : {}),
        run: () => selectChild(container.id, child.id),
      });
    }
  });
  return actions;
}

/** Read the optional `item` argument of `reveal:<node>`; anything else is refused. */
export function revealItemArgument(args: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return undefined;
  const item = args?.item;
  if (entries.length !== 1 || typeof item !== "string" || !item.trim()) {
    throw new Error("reveal accepts only { item: <non-empty stable item ID> }.");
  }
  return item;
}

export function buildRevealActions(
  snapshot: ProjectSnapshot | null,
  revealNode: (nodeId: string, itemId?: string) => void | Promise<void>,
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  const actions: PaletteAction[] = [];
  visit(snapshot.tree, (node) => {
    const label = nodeLabel(node, node.id === snapshot.tree!.id);
    actions.push({
      id: `reveal:${encodeURIComponent(node.id)}`,
      reference: `reveal:${encodeURIComponent(node.id)}`,
      label: `Reveal ${label}`,
      description: `Expand and show ${label} in the active dashboard; an item argument also highlights that item.`,
      keywords: ["reveal", "show", node.id, node.component, label],
      group: "Dashboard presentation",
      source: node.id,
      enabled: true,
      run: (_selections, args) => revealNode(node.id, revealItemArgument(args)),
    });
  });
  return actions;
}
