import { describe, expect, test } from "bun:test";
import {
  buildComponentAgentPrompt,
  buildComponentCreationAgentPrompt,
  buildDiagnosticsAgentPrompt,
  componentPath,
  dashboardInsertionPath,
  findResolvedNode,
  resolveDashboardInsertionPath,
} from "../../src/shared/component-agent";
import type {
  ComponentCatalogItem,
  ComponentNode,
  DashboardConfigSource,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import { componentAgentInvocation } from "../../src/main/component-agent";

const leaf = (node: ComponentNode) => ({
  type: "child" as const,
  child: { node },
});

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
    config: { schemaVersion: 2, name: "Test", root },
    configRevision: "revision",
    componentCatalog,
  };
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
      type: "tiled",
      layout: {
        type: "child",
        child: {
          node: {
            id: "status",
            component: "@dash-bored/status",
            props: { label: "API" },
            source: "builtin",
            sourceConfigPath,
            sourcePath: "root.children.layout.child.node",
          },
        },
      },
    },
  };
}

describe("component agent context", () => {
  test("finds a node and exposes an unambiguous config plus YAML locator", () => {
    const node = findResolvedNode(tree(), "status");
    expect(node).not.toBeNull();
    expect(componentPath(node!)).toBe(
      "/project/.dash-bored/dash-bored.yaml#root.children.layout.child.node",
    );
    expect(findResolvedNode(tree(), "missing")).toBeNull();
  });

  test("enriches the request with dash-bored and exact component context", () => {
    const prompt = buildComponentAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/.dash-bored/dash-bored.yaml",
      componentPath: "/project/.dash-bored/dash-bored.yaml#root.children.layout.child.node",
      componentId: "status",
      componentReference: "@dash-bored/status",
    }, "  Make the status green when healthy.  ");

    expect(prompt).toContain("dash-bored product and component-tree model");
    expect(prompt).toContain("Target component path: /project/.dash-bored/dash-bored.yaml#root.children.layout.child.node");
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

  test("tells an agent to build an unmatched component at the exact YAML insertion path", () => {
    const insertionPath = dashboardInsertionPath({
      parentPath: [{ type: "tiled", path: ["second"] }],
      placement: { type: "managed", index: 0 },
    }, "split");
    const prompt = buildComponentCreationAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/.dash-bored/dash-bored.yaml",
      insertionPath,
    }, "  Show deployment health by region.  ");

    expect(insertionPath).toBe(
      "root.children.layout.second.child.node.children.items[0]",
    );
    expect(prompt).toContain("Use the installed dash-bored skill when available.");
    expect(prompt).toContain("Build a project-local component for this dashboard");
    expect(prompt).toContain(
      "YAML insertion path: root.children.layout.second.child.node.children.items[0]",
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
      type: "tiled",
      layout: {
        type: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: leaf({
          component: "tabs",
          children: {
            type: "managed",
            items: [{ node: { component: "text" }, metadata: { label: "One" } }],
          },
        }),
        second: leaf({
          component: "horizontal",
          children: { type: "tiled", layout: leaf({ component: "text" }) },
        }),
      },
    },
  });

  test("returns exact managed, empty-tiled, and split-leaf YAML paths", () => {
    const source = configSource(nestedRoot(), catalog);
    expect(resolveDashboardInsertionPath(source, {
      parentPath: [{ type: "tiled", path: ["first"] }],
      placement: { type: "managed", index: 1, metadata: { label: "Two" } },
    })).toBe("root.children.layout.first.child.node.children.items[1]");

    expect(resolveDashboardInsertionPath(configSource({ component: "group" }, catalog), {
      parentPath: [],
      placement: {
        type: "tiled",
        path: [],
        axis: "vertical",
        position: "first",
      },
    })).toBe("root.children.layout.child");

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
      "root.children.layout.second.child.node.children.layout.second.child",
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
      children: { type: "managed", items: [] },
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

  test("rejects full parents and unavailable manifest contracts", () => {
    expect(resolveDashboardInsertionPath(configSource({
      component: "full",
      children: { type: "managed", items: [{ node: { component: "text" } }] },
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
