import { describe, expect, test } from "bun:test";
import {
  componentActionReference,
  isFocusOfNode,
  normalizeActionReference,
  parseActionReferenceNodeId,
  parseComponentActionReference,
  parseSelectionActionReference,
  remapActionReferenceNode,
} from "../../src/shared/action-reference";
import { resolveLegacyActionReference } from "../../src/migrations/action-references";

describe("action references", () => {
  test("parses node IDs and component action IDs", () => {
    expect(parseActionReferenceNodeId("focus:todo-list")).toBe("todo-list");
    expect(parseActionReferenceNodeId("component:todo-list:refresh")).toBe("todo-list");
    expect(parseActionReferenceNodeId("attention:todo-list")).toBe("todo-list");
    expect(parseActionReferenceNodeId("app:reload")).toBeUndefined();
    expect(parseActionReferenceNodeId("focus:%E0%A4%A")).toBeUndefined();
    expect(parseComponentActionReference("component:todo-list:refresh"))
      .toEqual({ nodeId: "todo-list", actionId: "refresh" });
    expect(componentActionReference("linked::pulse", "refresh-project-pulse"))
      .toBe("component:linked%3A%3Apulse:refresh-project-pulse");
  });

  test("resolves legacy positional references during the migration window", () => {
    expect(resolveLegacyActionReference("focus:${root.children.second.node}", (path) =>
      path === "root.children.second.node" ? "todo-list" : undefined)).toBe("focus:todo-list");
    expect(() => resolveLegacyActionReference("focus:${root.children[8].node}", () => undefined))
      .toThrow("does not exist");
  });

  test("remaps only node-bearing action segments for linked namespaces", () => {
    const remap = (id: string) => id === "pulse" ? "bundle::pulse" : undefined;
    expect(remapActionReferenceNode("focus:pulse", remap)).toBe("focus:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("process:pulse", remap)).toBe("process:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("attention:pulse", remap)).toBe("attention:bundle%3A%3Apulse");
    expect(remapActionReferenceNode("component:pulse:refresh", remap)).toBe("component:bundle%3A%3Apulse:refresh");
    expect(remapActionReferenceNode("app:reload", remap)).toBe("app:reload");
  });

  test("normalizes raw node IDs in app run references and leaves encoded ones alone", () => {
    expect(normalizeActionReference("focus:linked::pulse")).toBe("focus:linked%3A%3Apulse");
    expect(normalizeActionReference("process:linked::tests")).toBe("process:linked%3A%3Atests");
    expect(normalizeActionReference("attention:linked::pulse")).toBe("attention:linked%3A%3Apulse");
    expect(normalizeActionReference("notify:linked::pulse")).toBe("notify:linked%3A%3Apulse");
    expect(normalizeActionReference("reveal:linked::pulse")).toBe("reveal:linked%3A%3Apulse");
    expect(normalizeActionReference("component:linked::pulse:refresh")).toBe("component:linked%3A%3Apulse:refresh");

    for (const reference of [
      "focus:linked%3A%3Apulse",
      "focus:todo-list",
      "component:linked%3A%3Apulse:refresh",
      "component:todo-list:refresh",
      "select:tabs/child",
      "select:tabs::x/child",
      "app:open-palette",
    ]) {
      expect(normalizeActionReference(reference)).toBe(reference);
    }
    expect(normalizeActionReference(normalizeActionReference("focus:a::b"))).toBe("focus:a%3A%3Ab");
    expect(parseActionReferenceNodeId(normalizeActionReference("focus:linked::pulse"))).toBe("linked::pulse");
    expect(parseComponentActionReference(normalizeActionReference("component:linked::pulse:refresh")))
      .toEqual({ nodeId: "linked::pulse", actionId: "refresh" });
  });

  test("recognizes a focus action that names the focused node", () => {
    expect(isFocusOfNode("focus:linked%3A%3Apulse", "linked::pulse")).toBe(true);
    expect(isFocusOfNode("focus:logs", "logs")).toBe(true);
    expect(isFocusOfNode("focus:logs", "other")).toBe(false);
    expect(isFocusOfNode("focus:logs", null)).toBe(false);
    expect(isFocusOfNode("process:logs", "logs")).toBe(false);
    expect(isFocusOfNode("component:logs:refresh", "logs")).toBe(false);
  });

  test("parses and remaps selection actions by container and child ID", () => {
    expect(parseSelectionActionReference("select:tabs%2Fmain/child%3Aone")).toEqual({ containerId: "tabs/main", childId: "child:one" });
    expect(parseSelectionActionReference("select:bad")).toBeUndefined();
    expect(remapActionReferenceNode("select:tabs/child", (id) => `bundle::${id}`))
      .toBe("select:bundle%3A%3Atabs/bundle%3A%3Achild");
  });
});
