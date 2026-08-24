import { describe, expect, test } from "bun:test";
import {
  buildComponentAgentPrompt,
  componentPath,
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
});
