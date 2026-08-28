import { describe, expect, test } from "bun:test";
import {
  buildComponentAgentPrompt,
  buildComponentCreationAgentPrompt,
  componentPath,
  dashboardInsertionPath,
  findResolvedNode,
} from "../../src/shared/component-agent";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import { componentAgentInvocation } from "../../src/main/component-agent";

function tree(): ResolvedComponentNode {
  const sourceConfigPath = "/project/dash-bored/dash-bored.yaml";
  return {
    id: "root",
    component: "@dash-bored/stack",
    props: {},
    source: "builtin",
    sourceConfigPath,
    sourcePath: "root",
    slots: {
      children: [{
        id: "status",
        component: "@dash-bored/status",
        props: { label: "API" },
        slots: {},
        source: "builtin",
        sourceConfigPath,
        sourcePath: "root.slots.children[0]",
      }],
    },
  };
}

describe("component agent context", () => {
  test("finds a node and exposes an unambiguous config plus YAML locator", () => {
    const node = findResolvedNode(tree(), "status");
    expect(node).not.toBeNull();
    expect(componentPath(node!)).toBe(
      "/project/dash-bored/dash-bored.yaml#root.slots.children[0]",
    );
    expect(findResolvedNode(tree(), "missing")).toBeNull();
  });

  test("enriches the request with dash-bored and exact component context", () => {
    const prompt = buildComponentAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/dash-bored/dash-bored.yaml",
      componentPath: "/project/dash-bored/dash-bored.yaml#root.slots.children[0]",
      componentId: "status",
      componentReference: "@dash-bored/status",
    }, "  Make the status green when healthy.  ");

    expect(prompt).toContain("dash-bored product and component-tree model");
    expect(prompt).toContain("Target component path: /project/dash-bored/dash-bored.yaml#root.slots.children[0]");
    expect(prompt).toEndWith("User request:\nMake the status green when healthy.");
  });

  test("passes the enriched prompt as one environment-backed shell argument", () => {
    const invocation = componentAgentInvocation(" codex exec ");
    expect(invocation.startsWith("codex exec ")).toBeTrue();
    expect(invocation).toContain("DASH_BORED_AGENT_PROMPT");
  });

  test("tells an agent to build an unmatched component at the exact YAML insertion path", () => {
    const insertionPath = dashboardInsertionPath({
      parentPath: [{ slot: "children", index: 1 }],
      slot: "content",
      index: 0,
    });
    const prompt = buildComponentCreationAgentPrompt({
      projectRoot: "/project",
      configPath: "/project/dash-bored/dash-bored.yaml",
      insertionPath,
    }, "  Show deployment health by region.  ");

    expect(insertionPath).toBe("root.slots.children[1].slots.content[0]");
    expect(prompt).toContain("Use the installed dash-bored skill when available.");
    expect(prompt).toContain("Build a project-local component for this dashboard");
    expect(prompt).toContain("YAML insertion path: root.slots.children[1].slots.content[0]");
    expect(prompt).toEndWith("User component description:\nShow deployment health by region.");
  });
});
