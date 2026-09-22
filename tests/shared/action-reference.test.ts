import { describe, expect, test } from "bun:test";
import {
  componentActionReference,
  parseActionReferenceNodeId,
  parseComponentActionReference,
  parseSelectionActionReference,
  remapActionReferenceNode,
} from "../../src/shared/action-reference";
import { migrateActionReferences, resolveLegacyActionReference } from "../../src/core/action-reference-migration";
import type { DashboardConfig } from "../../src/shared/contracts";

const config: DashboardConfig = {
  schemaVersion: 3,
  name: "Action refs",
  root: {
    id: "root",
    component: "group",
    children: {
      axis: "horizontal",
      first: { node: { component: "button", props: { action: "focus:${root.children.first.node}" } } },
      second: { node: { id: "todo-list", component: "todo-list" } },
    },
  },
};

describe("action references", () => {
  test("parses node IDs and component action IDs", () => {
    expect(parseActionReferenceNodeId("focus:todo-list")).toBe("todo-list");
    expect(parseActionReferenceNodeId("component:todo-list:refresh")).toBe("todo-list");
    expect(parseActionReferenceNodeId("app:reload")).toBeUndefined();
    expect(parseActionReferenceNodeId("focus:%E0%A4%A")).toBeUndefined();
    expect(parseComponentActionReference("component:todo-list:refresh"))
      .toEqual({ nodeId: "todo-list", actionId: "refresh" });
    expect(componentActionReference("linked::pulse", "refresh-project-pulse"))
      .toBe("component:linked%3A%3Apulse:refresh-project-pulse");
  });

  test("rewrites legacy references and assigns IDs only when needed", () => {
    const result = migrateActionReferences(config);
    expect(result.migrated).toBe(1);
    expect(result.assignedIds).toBe(1);
    expect(result.diagnostics).toEqual([]);
    const children = result.config.root.children as { first: { node: { id?: string; props?: Record<string, unknown> } } };
    expect(children.first.node.id).toBe("action-target-1");
    expect(children.first.node.props?.action).toBe("focus:action-target-1");
  });

  test("rewrites references at manifest-declared nested prop paths", () => {
    const nested = structuredClone(config);
    nested.root.children = {
      axis: "horizontal",
      first: { node: { id: "agent-button", component: "./local-button", props: { action: { run: "component:${root.children.second.node}:refresh" } } } },
      second: { node: { id: "todo-list", component: "todo-list" } },
    };
    const result = migrateActionReferences(nested, (_component, path) => path === "action.run");
    expect(result.migrated).toBe(1);
    const children = result.config.root.children as { first: { node: { props?: Record<string, unknown> } } };
    expect(children.first.node.props?.action).toEqual({ run: "component:todo-list:refresh" });
  });

  test("supports schema-v3 runtime resolution during the migration window", () => {
    expect(resolveLegacyActionReference("focus:${root.children.second.node}", (path) =>
      path === "root.children.second.node" ? "todo-list" : undefined)).toBe("focus:todo-list");
    expect(() => resolveLegacyActionReference("focus:${root.children[8].node}", () => undefined))
      .toThrow("does not exist");
  });

  test("remaps only node-bearing action segments for linked namespaces", () => {
    const remap = (id: string) => id === "pulse" ? "bundle::pulse" : undefined;
    expect(remapActionReferenceNode("focus:pulse", remap)).toBe("focus:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("process:pulse", remap)).toBe("process:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("component:pulse:refresh", remap)).toBe("component:bundle%3A%3Apulse:refresh");
    expect(remapActionReferenceNode("app:reload", remap)).toBe("app:reload");
  });

  test("parses and remaps selection actions by container and child ID", () => {
    expect(parseSelectionActionReference("select:tabs%2Fmain/child%3Aone")).toEqual({ containerId: "tabs/main", childId: "child:one" });
    expect(parseSelectionActionReference("select:bad")).toBeUndefined();
    expect(remapActionReferenceNode("select:tabs/child", (id) => `bundle::${id}`))
      .toBe("select:bundle%3A%3Atabs/bundle%3A%3Achild");
  });
});
