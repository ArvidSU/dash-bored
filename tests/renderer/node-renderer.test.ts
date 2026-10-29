import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { configLinkManifest } from "../../src/core/tree-links";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import type { DashboardRenderContextValue } from "../../src/renderer/render/NodeRenderer";
import { ActionStore } from "../../src/renderer/lib/actions";

// The renderer's live RPC transport is not used during server rendering.
mock.module("electrobun/view", () => ({ Electroview: { defineRPC: () => ({}) } }));
const { DashboardRenderContext, NodeRenderer } = await import("../../src/renderer/render/NodeRenderer");

const node: ResolvedComponentNode = {
  id: "example", component: "./components/example", props: {}, source: "local",
  manifest: { schemaVersion: 3, apiVersion: "2.0.0", id: "example", name: "Example", description: "", entry: "./index.tsx", propsSchema: {} },
};

function render(target: ResolvedComponentNode, overrides: Partial<DashboardRenderContextValue> = {}): string {
  const context: DashboardRenderContextValue = {
    trusted: true, processesRef: { current: new Map() }, localComponents: new Map(),
    actionStore: new ActionStore(), actionScope: "test",
    actionController: { resolve: () => { throw new Error("unexpected action"); }, invoke: () => {} },
    updateBatch: { generation: 1, delays: new Map([[target.id, 20]]) },
    collapsedNodeIds: new Set(), splitRatioOverrides: {}, componentHeightOverrides: {},
    onFocus: () => {}, onToggleCollapse: () => {}, onSplitRatioChange: () => {},
    onComponentHeightChange: () => {}, onCopyPath: () => {}, onEditComponent: () => {},
    onOpenAgent: () => {}, onUpdateProps: async () => {}, focusedNodeId: null, childSelections: {},
    ...overrides,
  };
  // These client-only components use layout effects; the static render checks
  // their initial markup without hydrating it.
  const originalError = console.error;
  console.error = (message, ...args) => {
    if (typeof message !== "string" || !message.startsWith("Warning: useLayoutEffect does nothing on the server")) originalError(message, ...args);
  };
  try {
    return renderToStaticMarkup(createElement(DashboardRenderContext.Provider, { value: context }, createElement(NodeRenderer, { node: target })));
  } finally {
    console.error = originalError;
  }
}

describe("component frames", () => {
  const component = () => createElement("p", null, "Rendered component");
  const loaded = (componentValue: typeof component | null, loading: boolean, error: string | null) => new Map([
    ["example", { componentId: "example", revision: "1", component: componentValue, loading, error }],
  ]);

  test("renders a config link's managed child while preserving collapse, trust, and failure boundaries", () => {
    const link: ResolvedComponentNode = {
      id: "linked-dashboard",
      component: "./linked",
      props: {},
      source: "config",
      configName: "Linked dashboard",
      manifest: configLinkManifest("./linked", "Linked dashboard"),
      children: [{ node }],
    };
    const overrides = { localComponents: loaded(component, false, null) };

    const expanded = render(link, overrides);
    expect(expanded).toContain("Rendered component");
    expect(expanded).toContain('data-node-id="example"');

    const collapsed = render(link, { ...overrides, collapsedNodeIds: new Set([link.id]) });
    expect(collapsed).toContain('data-collapsed="true"');
    expect(collapsed).not.toContain("Rendered component");

    const untrusted = render(link, { ...overrides, trusted: false });
    expect(untrusted).toContain("Trust this project");
    expect(untrusted).not.toContain("Rendered component");

    const failed = render({ ...link, configError: "Linked config invalid" }, overrides);
    expect(failed).toContain("Could not load Linked dashboard");
    expect(failed).toContain("Linked config invalid");
    expect(failed).not.toContain("Rendered component");
  });

  const cases: Array<{ target: ResolvedComponentNode; overrides?: Partial<DashboardRenderContextValue>; visible: string[] }> = [
    { target: { ...node, source: "config", configName: "Linked", configError: "Bad config" }, overrides: { trusted: false }, visible: ["<section", "Could not load Linked", "Bad config", 'role="alert"'] },
    { target: { ...node, source: "config" }, visible: ["<section", "config-link__content"] },
    { target: node, overrides: { trusted: false }, visible: ["component-state--locked", "Trust this project"] },
    { target: { ...node, manifest: undefined }, visible: ['role="alert"', "has no manifest ID"] },
    { target: node, visible: ['aria-live="polite"', "Loading Example"] },
    { target: node, overrides: { localComponents: loaded(null, false, "Compile failed") }, visible: ['role="alert"', "Compile failed"] },
    { target: node, overrides: { localComponents: loaded(component, true, "Update failed") }, visible: ["Rendered component", 'role="status"', "showing previous version"] },
  ];

  for (const { target, overrides, visible } of cases) {
    test(`preserves ${visible[0]} and collapse behavior`, () => {
      const expanded = render(target, overrides);
      for (const text of visible) expect(expanded).toContain(text);
      expect(expanded.match(/class="component-node__update-polish"/g)).toHaveLength(1);
      const collapsed = render(target, { ...overrides, collapsedNodeIds: new Set([target.id]) });
      expect(collapsed).toContain('data-collapsed="true"');
      expect(collapsed).not.toContain("component-node__update-polish");
      expect(collapsed).not.toContain("Rendered component");
    });
  }
});
