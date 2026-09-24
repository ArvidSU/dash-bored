import { describe, expect, test } from "bun:test";
import {
  buildComponentAgentPrompt,
  buildComponentCreationAgentPrompt,
  buildDiagnosticsAgentPrompt,
  componentPath,
  dashboardInsertionPath,
  describeDashboardInsertion,
  findResolvedNode,
  resolveDashboardInsertion,
} from "../../src/shared/component-agent";
import type {
  ComponentCatalogItem,
  ComponentNode,
  DashboardConfigSource,
  DashboardInsertionTarget,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import { componentAgentInvocation } from "../../src/main/component-agent";
import { insertNode } from "../../src/renderer/composition/dashboard-editor";

const leaf = (node: ComponentNode) => ({ node });

const resolveDashboardInsertionPath = (
  source: DashboardConfigSource,
  target: DashboardInsertionTarget,
): string | null => resolveDashboardInsertion(source, target)?.path ?? null;

function catalogItem(
  reference: string,
  children?: NonNullable<ComponentCatalogItem["manifest"]>["children"],
): ComponentCatalogItem {
  return {
    reference,
    source: "builtin",
    available: true,
    manifest: {
      schemaVersion: 2,
      id: reference,
      name: reference,
      description: `${reference} test component`,
      entry: `builtin:${reference}`,
      propsSchema: { type: "object" },
      ...(children === undefined ? {} : { children }),
    },
    diagnostics: [],
  };
}

function configSource(
  root: ComponentNode,
  componentCatalog: ComponentCatalogItem[],
): DashboardConfigSource {
  return {
    configPath: "/project/.dash-bored/dash-bored.yaml",
    config: { schemaVersion: 3, name: "Test", root },
    configRevision: "revision",
    componentCatalog,
  };
}

/** Reads a YAML locator such as `root.children.first.node.children[1]`. */
function atYamlPath(config: DashboardConfigSource["config"], path: string): unknown {
  let current: unknown = { root: config.root };
  for (const segment of path.split(".")) {
    const indexed = segment.match(/^(\w+)\[(\d+)\]$/);
    const record = current as Record<string, unknown> | undefined;
    current = indexed
      ? (record?.[indexed[1]!] as unknown[] | undefined)?.[Number(indexed[2])]
      : record?.[segment];
  }
  return current;
}

function tree(): ResolvedComponentNode {
  const sourceConfigPath = "/project/.dash-bored/dash-bored.yaml";
  return {
    id: "root",
    component: "@dash-bored/group",
    props: {},
    source: "builtin",
    sourceConfigPath,
    sourcePath: "root",
    children: {
        node: {
            id: "status",
            component: "@dash-bored/status",
            props: { label: "API" },
            source: "builtin",
            sourceConfigPath,
            sourcePath: "root.children.node"
        }
    },
  };
}

describe("component agent context", () => {
  test("finds a node and exposes an unambiguous config plus YAML locator", () => {
    const node = findResolvedNode(tree(), "status");
    expect(node).not.toBeNull();
    expect(componentPath(node!)).toBe(
      "/project/.dash-bored/dash-bored.yaml#root.children.node",
    );
    expect(findResolvedNode(tree(), "missing")).toBeNull();
  });

  test("enriches the request with dash-bored and exact component context", () => {
    const prompt = buildComponentAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/.dash-bored/dash-bored.yaml",
      componentPath: "/project/.dash-bored/dash-bored.yaml#root.children.node",
      componentId: "status",
      componentReference: "@dash-bored/status",
    }, "  Make the status green when healthy.  ");

    expect(prompt).toContain("dash-bored product and component-tree model");
    expect(prompt).toContain("Target component path: /project/.dash-bored/dash-bored.yaml#root.children.node");
    expect(prompt).toEndWith("User request:\nMake the status green when healthy.");
  });

  test("passes the enriched prompt as one environment-backed shell argument", () => {
    const invocation = componentAgentInvocation(" codex exec ");
    expect(invocation.startsWith("codex exec ")).toBeTrue();
    expect(invocation).toContain("DASH_BORED_AGENT_PROMPT");
  });

  test("gives a diagnostics repair request the owning dashboard and reported issues", () => {
    const prompt = buildDiagnosticsAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/.dash-bored/dash-bored.yaml",
      diagnostics: [{
        severity: "error",
        code: "COMPONENT_UNAVAILABLE",
        message: "Component ./components/missing is unavailable.",
        path: "root.component",
      }],
    });

    expect(prompt).toContain("fixing a dash-bored dashboard configuration");
    expect(prompt).toContain("Owning dashboard config: /project/.dash-bored/dash-bored.yaml");
    expect(prompt).toContain("- ERROR COMPONENT_UNAVAILABLE: Component ./components/missing is unavailable. (root.component)");
  });

  test("prefers a source-backed built-in view and states the exact placement", () => {
    const prompt = buildComponentCreationAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/.dash-bored/dash-bored.yaml",
      insertion: {
        path: dashboardInsertionPath({
          parentPath: [],
          placement: { type: "tiled", path: [], axis: "vertical", position: "second" },
        }, "split"),
        parentPath: "root",
        parent: { id: "cockpit", component: "@dash-bored/group" },
        placement: {
          type: "split",
          edgePath: "root.children",
          existing: { id: "status", component: "@dash-bored/status" },
          axis: "vertical",
          position: "second",
        },
      },
    }, "  Show deployment health by region.  ");

    expect(prompt).toContain("Use the installed dash-bored skill when available.");
    expect(prompt).not.toContain("No component in the dashboard catalog matched");
    expect(prompt).toContain(
      "a built-in view (status, list, chart, or markdown) fed by a small source script often still fits",
    );
    expect(prompt).toContain("build a small project-local component only when no view can present it");
    expect(prompt).toContain("YAML insertion path: root.children.second");
    expect(prompt).toContain(
      "Placement: Split the tile of node `status` (@dash-bored/status) so the new node sits below it: "
        + "replace the edge at root.children with "
        + "`{ axis: vertical, first: <existing edge, unchanged>, second: { node: <new node> } }`. "
        + "Vertical splits have no `ratio`.",
    );
    expect(prompt).toEndWith("User component description:\nShow deployment health by region.");
  });
});

describe("dashboard insertion target validation", () => {
  const group = catalogItem("group", {
    min: 0,
    max: 4,
    presentation: { type: "tiled", axes: "both" },
  });
  const horizontal = catalogItem("horizontal", {
    min: 0,
    max: 2,
    presentation: { type: "tiled", axes: "horizontal" },
  });
  const tabs = catalogItem("tabs", {
    min: 1,
    max: 2,
    presentation: { type: "managed" },
  });
  const full = catalogItem("full", {
    min: 0,
    max: 1,
    presentation: { type: "managed" },
  });
  const pair = catalogItem("pair", {
    min: 2,
    max: 3,
    presentation: { type: "tiled", axes: "both" },
  });
  const text = catalogItem("text");
  const catalog = [group, horizontal, tabs, full, pair, text];

  const nestedRoot = (): ComponentNode => ({
    component: "group",
    children: {
        axis: "horizontal",
        ratio: 0.5,
        first: leaf({
            component: "tabs",
            children: [{ node: { component: "text" }, metadata: { label: "One" } }]
        }),
        second: leaf({
            component: "horizontal",
            children: leaf({ component: "text" })
        })
    },
  });

  test("returns exact managed, empty-tiled, and split-leaf YAML paths", () => {
    const source = configSource(nestedRoot(), catalog);
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["first"] }],
      placement: { type: "managed", index: 1, metadata: { label: "Two" } },
    })).toBe("root.children.first.node.children[1]");

    expect(resolveDashboardInsertionPath(configSource({ component: "group" }, catalog), {
      parentPath: [],
      placement: {
        type: "tiled",
        path: [],
        axis: "vertical",
        position: "first",
      },
    })).toBe("root.children");

    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["second"] }],
      placement: {
        type: "tiled",
        path: [],
        axis: "horizontal",
        position: "second",
        ratio: 0.4,
      },
    })).toBe(
      "root.children.second.node.children.second",
    );
  });

  test("rejects stale managed indices and tiled paths", () => {
    const source = configSource(nestedRoot(), catalog);
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "managed", index: 0 }],
      placement: { type: "managed", index: 0 },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [
        { type: "tiled", path: ["first"] },
        { type: "managed", index: 1 },
      ],
      placement: { type: "managed", index: 0 },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["first"] }],
      placement: { type: "managed", index: 2 },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["second"] }],
      placement: {
        type: "tiled",
        path: ["first"],
        axis: "horizontal",
        position: "first",
      },
    })).toBeNull();
  });

  test("rejects disallowed axes, invalid ratios, and presentation mismatches", () => {
    const source = configSource(nestedRoot(), catalog);
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["second"] }],
      placement: {
        type: "tiled",
        path: [],
        axis: "vertical",
        position: "first",
      },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["second"] }],
      placement: {
        type: "tiled",
        path: [],
        axis: "horizontal",
        position: "first",
        ratio: 0.95,
      },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["first"] }],
      placement: {
        type: "tiled",
        path: [],
        axis: "horizontal",
        position: "first",
      },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(configSource({
      component: "group",
      children: [],
    }, catalog), {
      parentPath: [],
      placement: {
        type: "tiled",
        path: [],
        axis: "horizontal",
        position: "first",
      },
    })).toBeNull();
  });

  test("states each placement as the edit the structural editor makes", () => {
    const newNode: ComponentNode = { id: "deploy-health", component: "text" };
    const cases: Array<{
      root: ComponentNode;
      target: DashboardInsertionTarget;
      placement: string;
      check: (config: DashboardConfigSource["config"]) => void;
    }> = [
      {
        root: nestedRoot(),
        target: {
          parentPath: [{ type: "tiled", path: ["second"] }],
          placement: { type: "tiled", path: [], axis: "horizontal", position: "first", ratio: 0.4 },
        },
        placement: "Split the tile of the text node so the new node sits left of it: replace the edge at "
          + "root.children.second.node.children with `{ axis: horizontal, ratio: 0.4, "
          + "first: { node: <new node> }, second: <existing edge, unchanged> }`.",
        check: (config) => {
          expect(atYamlPath(config, "root.children.second.node.children")).toMatchObject({
            axis: "horizontal",
            ratio: 0.4,
            second: { node: { component: "text" } },
          });
        },
      },
      {
        root: nestedRoot(),
        target: {
          parentPath: [{ type: "tiled", path: ["second"] }],
          placement: { type: "tiled", path: [], axis: "horizontal", position: "second", ratio: 0.5 },
        },
        placement: "Split the tile of the text node so the new node sits right of it: replace the edge at "
          + "root.children.second.node.children with `{ axis: horizontal, "
          + "first: <existing edge, unchanged>, second: { node: <new node> } }`. Omit `ratio` (equal widths).",
        check: (config) => {
          expect(atYamlPath(config, "root.children.second.node.children.ratio")).toBeUndefined();
        },
      },
      {
        root: { component: "group" },
        target: {
          parentPath: [],
          placement: { type: "tiled", path: [], axis: "vertical", position: "first" },
        },
        placement: "The group node at root has no children yet; set its `children` to the single edge "
          + "`{ node: <new node> }`, with no split.",
        check: (config) => {
          expect(atYamlPath(config, "root.children")).toEqual({ node: newNode });
        },
      },
      {
        root: nestedRoot(),
        target: {
          parentPath: [{ type: "tiled", path: ["first"] }],
          placement: { type: "managed", index: 0, metadata: { label: "Item 1" } },
        },
        placement: "Insert the new edge `{ metadata: {\"label\":\"Item 1\"}, node: <new node> }` into the "
          + "`children` list of the tabs node at root.children.first.node at index 0, before the item now at "
          + "that index. Replace placeholder metadata values with a fitting name.",
        check: (config) => {
          expect(atYamlPath(config, "root.children.first.node.children[1].metadata")).toEqual({ label: "One" });
        },
      },
      {
        root: nestedRoot(),
        target: {
          parentPath: [{ type: "tiled", path: ["first"] }],
          placement: { type: "managed", index: 1, metadata: {} },
        },
        placement: "Append the new edge `{ node: <new node> }` to the `children` list of the tabs node at "
          + "root.children.first.node, after its 1 current item.",
        check: (config) => {
          expect(atYamlPath(config, "root.children.first.node.children[0].metadata")).toEqual({ label: "One" });
        },
      },
      {
        root: { component: "full" },
        target: { parentPath: [], placement: { type: "managed", index: 0 } },
        placement: "The full node at root has no children yet; set its `children` to a list holding only "
          + "the new edge `{ node: <new node> }`.",
        check: (config) => {
          expect(atYamlPath(config, "root.children")).toHaveLength(1);
        },
      },
    ];

    for (const { root, target, placement, check } of cases) {
      const source = configSource(root, catalog);
      const insertion = resolveDashboardInsertion(source, target);
      expect(insertion).not.toBeNull();
      expect(describeDashboardInsertion(insertion!)).toBe(placement);
      const edited = insertNode(source.config, target, newNode, catalog);
      expect((atYamlPath(edited, insertion!.path) as { node: ComponentNode }).node).toEqual(newNode);
      check(edited);
    }
  });

  test("rejects full parents and unavailable manifest contracts", () => {
    expect(resolveDashboardInsertionPath(configSource({
      component: "full",
      children: [{ node: { component: "text" } }],
    }, catalog), {
      parentPath: [],
      placement: { type: "managed", index: 1 },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(configSource({ component: "missing" }, catalog), {
      parentPath: [],
      placement: { type: "managed", index: 0 },
    })).toBeNull();
    expect(resolveDashboardInsertionPath(configSource({ component: "pair" }, catalog), {
      parentPath: [],
      placement: {
        type: "tiled",
        path: [],
        axis: "horizontal",
        position: "first",
      },
    })).toBeNull();
  });
});
