import { describe, expect, test } from "bun:test";
import {
  componentActionReference,
  interpolateActionReference,
  remapActionReferenceNode,
} from "../../src/shared/action-reference";

describe("action references", () => {
  test("interpolates canonical YAML node paths into encoded action ids", () => {
    const path = "root.children[2].node.children.first.first.node.children.node";
    expect(interpolateActionReference(`focus:\${${path}}`, (candidate) =>
      candidate === path ? "yaml-todo" : undefined)).toBe("focus:yaml-todo");
    expect(componentActionReference("linked::pulse", "refresh-project-pulse"))
      .toBe("component:linked%3A%3Apulse:refresh-project-pulse");
  });

  test("rejects malformed and missing node paths without touching literal ids", () => {
    expect(interpolateActionReference("app:reload", () => undefined)).toBe("app:reload");
    expect(() => interpolateActionReference("focus:${root.children.nope.node}", () => undefined))
      .toThrow("Malformed component node path");
    expect(() => interpolateActionReference("focus:${root.children[8].node}", () => undefined))
      .toThrow("does not exist");
    expect(() => interpolateActionReference("focus:${root.children[0].node", () => undefined))
      .toThrow("Malformed component node path interpolation");
  });

  test("remaps only node-bearing action segments for linked namespaces", () => {
    const remap = (id: string) => id === "pulse" ? "bundle::pulse" : undefined;
    expect(remapActionReferenceNode("focus:pulse", remap)).toBe("focus:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("process:pulse", remap)).toBe("process:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("component:pulse:refresh", remap)).toBe("component:bundle%3A%3Apulse:refresh");
    expect(remapActionReferenceNode("app:reload", remap)).toBe("app:reload");
  });
});
