import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  DashboardConfig,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import { buildCompositionPreviewTree } from "../../src/renderer/composition-preview";
import { insertNode, updateNodeProps } from "../../src/renderer/dashboard-editor";

function manifest(id: string, children?: ComponentManifest["children"]): ComponentManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    description: `${id} component`,
    entry: `builtin:${id}`,
    propsSchema: { type: "object", additionalProperties: true },
    ...(children ? { children } : {}),
  };
}

const group = manifest("@dash-bored/group", { min: 0, presentation: { type: "tiled", axes: "both" } });
const text = manifest("@dash-bored/text");
const local = manifest("local-notebook");
const catalog: ComponentCatalogItem[] = [group, text].map((value) => ({
  reference: value.id,
  source: "builtin",
  available: true,
  manifest: value,
  diagnostics: [],
}));
catalog.push({
  reference: "./components/notebook",
  source: "local",
  available: true,
  manifest: local,
  diagnostics: [],
});

const config: DashboardConfig = {
  schemaVersion: 2,
  name: "Preview",
  root: {
    id: "root",
    component: group.id,
    children: {
      type: "tiled",
      layout: { type: "child", child: { node: { id: "first", component: text.id, props: { content: "old" } } } },
    },
  },
};

const resolved: ResolvedComponentNode = {
  id: "root",
  component: group.id,
  props: {},
  source: "builtin",
  manifest: group,
  children: {
    type: "tiled",
    layout: { type: "child", child: { node: { id: "first", component: text.id, props: { content: "old" }, source: "builtin", manifest: text } } },
  },
};

describe("composition draft preview", () => {
  test("overlays inserted topology and keeps known resolved identity", () => {
    const draft = insertNode(config, {
      parentPath: [],
      placement: { type: "tiled", path: [], axis: "horizontal", position: "second" },
    }, { id: "second", component: text.id, props: { content: "new" } }, catalog);
    const preview = buildCompositionPreviewTree(draft, resolved, catalog, "/project/dash-bored.yaml");
    expect(preview.children?.type).toBe("tiled");
    if (preview.children?.type !== "tiled" || preview.children.layout.type !== "split") throw new Error("expected split preview");
    expect(preview.children.layout.first).toMatchObject({ type: "child", child: { node: { id: "first", props: { content: "old" } } } });
    expect(preview.children.layout.second).toMatchObject({ type: "child", child: { node: { id: "second", props: { content: "new" }, source: "builtin", manifest: text } } });
  });

  test("overlays props without replacing the last-known resolved manifest", () => {
    const draft = updateNodeProps(config, [{ type: "tiled", path: [] }], { content: "changed" });
    const preview = buildCompositionPreviewTree(draft, resolved, catalog, "/project/dash-bored.yaml");
    if (preview.children?.type !== "tiled") throw new Error("expected tiled preview");
    expect(preview.children.layout).toMatchObject({ child: { node: { id: "first", props: { content: "changed" }, manifest: text } } });
  });

  test("keeps linked local component identities in the active namespace", () => {
    const linkedResolved: ResolvedComponentNode = {
      ...resolved,
      id: "dashboard-link::root",
    };
    const draft = insertNode(config, {
      parentPath: [],
      placement: { type: "tiled", path: [], axis: "horizontal", position: "second" },
    }, { id: "notebook", component: "./components/notebook" }, catalog);
    const preview = buildCompositionPreviewTree(
      draft,
      linkedResolved,
      catalog,
      "/project/linked.yaml",
      "dashboard-link",
    );
    if (preview.children?.type !== "tiled" || preview.children.layout.type !== "split") {
      throw new Error("expected split preview");
    }
    expect(preview.children.layout.second).toMatchObject({
      child: {
        node: {
          id: "dashboard-link::notebook",
          manifest: { id: "dashboard-link::local-notebook" },
        },
      },
    });
  });
});
