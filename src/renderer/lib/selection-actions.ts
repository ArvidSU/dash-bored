import type { ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { PaletteAction } from "./actions";
import { childNodes } from "./component-children";
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
    const selected = selections[container.id]
      ?? (typeof container.props.defaultChild === "string" ? container.props.defaultChild : undefined)
      ?? definition.defaultChild ?? container.children[0]?.node.id;
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

export function buildRevealActions(
  snapshot: ProjectSnapshot | null,
  revealedNodeId: string | null,
  revealNode: (nodeId: string) => void,
): PaletteAction[] {
  if (!snapshot?.tree) return [];
  const actions: PaletteAction[] = [];
  visit(snapshot.tree, (node) => {
    const label = nodeLabel(node, node.id === snapshot.tree!.id);
    actions.push({
      id: `reveal:${encodeURIComponent(node.id)}`,
      reference: `reveal:${encodeURIComponent(node.id)}`,
      label: `Reveal ${label}`,
      description: `Expand and show ${label} in the active dashboard.`,
      keywords: ["reveal", "show", node.id, node.component, label],
      group: "Dashboard presentation",
      source: node.id,
      active: revealedNodeId === node.id,
      enabled: true,
      run: () => revealNode(node.id),
    });
  });
  return actions;
}
