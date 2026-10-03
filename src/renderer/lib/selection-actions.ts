import type { ComponentActionOption, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { PaletteAction } from "./actions";
import { childNodes } from "./component-children";
import { selectedChildId } from "./component-view-state";
import { dashboardNodeEntries, dashboardNodeOptionDescription, nodeLabel } from "./virtual-root";

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
  const options: ComponentActionOption[] = [];
  const entries = new Map(dashboardNodeEntries(snapshot.tree).map((entry) => [entry.node.id, entry] as const));
  visit(snapshot.tree, (container) => {
    const definition = container.manifest?.children;
    if (definition?.select !== "single" || !Array.isArray(container.children)) return;
    const selected = selectedChildId(container, selections);
    const containerEntry = entries.get(container.id);
    const containerLabel = containerEntry?.label ?? nodeLabel(container, false);
    for (const edge of container.children) {
      const child = edge.node;
      // A panel label is metadata on the parent-child edge; fall back to the node's own name.
      const edgeLabel = typeof edge.metadata?.label === "string" ? edge.metadata.label.trim() : "";
      const label = edgeLabel || nodeLabel(child, false);
      const id = `select:${encodeURIComponent(container.id)}/${encodeURIComponent(child.id)}`;
      actions.push({
        id,
        reference: id,
        parentActionId: "project:select",
        label: `Select ${label}`,
        description: `Show ${label} in ${containerLabel}.`,
        keywords: ["select", "panel", container.id, child.id, label],
        group: "Dashboard presentation",
        source: child.id,
        active: selected === child.id,
        enabled: selected !== child.id,
        ...(selected === child.id ? { disabledReason: "This child is already selected." } : {}),
        run: () => selectChild(container.id, child.id),
      });
      if (selected !== child.id) {
        const location = containerEntry?.path.slice(1) ?? [];
        options.push({ value: id, label, description: `${child.id} · ${(location.length > 0 ? location : [containerLabel]).join(" › ")}` });
      }
    }
  });
  if (actions.length === 0) return [];
  return [{
    id: "project:select",
    label: "Select panel",
    description: "Choose a tab or panel to show in the active dashboard.",
    keywords: ["select", "panel", "tab", "switch"],
    group: "Dashboard presentation",
    enabled: options.length > 0,
    ...(options.length === 0 ? { disabledReason: "Every panel is already selected." } : {}),
    ...(options.length > 0 ? { choices: [{ id: "panel", label: "Select panel", options }] } : {}),
    run: (choice) => {
      const target = actions.find((action) => action.id === choice?.panel && action.enabled);
      if (!target) throw new Error("Choose an available panel to select.");
      return target.run();
    },
  } satisfies PaletteAction, ...actions];
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
  const targets = dashboardNodeEntries(snapshot.tree).map((entry) => {
    const { node, label } = entry;
    const action: PaletteAction = {
      id: `reveal:${encodeURIComponent(node.id)}`,
      reference: `reveal:${encodeURIComponent(node.id)}`,
      parentActionId: "project:reveal",
      label: `Reveal ${label}`,
      description: `Expand and show ${label} in the active dashboard; an item argument also highlights that item.`,
      keywords: ["reveal", "show", node.id, node.component, label],
      group: "Dashboard presentation",
      source: node.id,
      enabled: true,
      run: (_selections, args) => revealNode(node.id, revealItemArgument(args)),
    };
    return { action, entry };
  });
  const actions = targets.map(({ action }) => action);
  return [{
    id: "project:reveal",
    label: "Reveal component",
    description: "Choose a component to expand and show in the active dashboard.",
    // Search reaches individual targets through the chooser's options.
    keywords: ["reveal", "show"],
    group: "Dashboard presentation",
    enabled: true,
    choices: [{
      id: "node",
      label: "Reveal component",
      options: targets.map(({ entry }) => ({
        value: entry.node.id,
        label: entry.label,
        description: dashboardNodeOptionDescription(entry),
      })),
    }],
    run: (selections) => {
      const target = actions.find((action) => action.source === selections?.node);
      if (!target) throw new Error("Choose an available component to reveal.");
      return target.run();
    },
  } satisfies PaletteAction, ...actions];
}
