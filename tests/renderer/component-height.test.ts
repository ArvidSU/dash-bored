import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  componentHeightOverridesStorageKey,
  componentRendersSurface,
  normalizeComponentHeight,
  parseComponentHeightOverrides,
  pruneComponentHeightOverrides,
  serializeComponentHeightOverrides,
} from "../../src/renderer/component-height";

function node(
  id: string,
  renderMode: "surface" | "layout" = "surface",
  child?: ResolvedComponentNode,
): ResolvedComponentNode {
  return {
    id,
    component: id,
    props: {},
    source: "builtin",
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      description: id,
      entry: `builtin:${id}`,
      renderMode,
      propsSchema: { type: "object" },
    },
    ...(child ? {
      children: {
        type: "tiled" as const,
        layout: { type: "child" as const, child: { node: child } },
      },
    } : {}),
  };
}

describe("component height presentation state", () => {
  test("classifies visual surfaces independently from organizational nodes", () => {
    expect(componentRendersSurface(node("card"))).toBeTrue();
    expect(componentRendersSurface(node("group", "layout"))).toBeFalse();
    expect(componentRendersSurface({ source: "config" })).toBeFalse();
    expect(componentRendersSurface({ source: "local" })).toBeTrue();
  });

  test("round-trips bounded caps under a config-specific storage key", () => {
    expect(componentHeightOverridesStorageKey("/tmp/dash-bored.yaml"))
      .toBe("dash-bored:component-heights:/tmp/dash-bored.yaml");
    expect(normalizeComponentHeight(55)).toBeUndefined();
    expect(normalizeComponentHeight(120.4)).toBe(120);
    expect(parseComponentHeightOverrides('{"card":120,"small":20,"bad":"80"}'))
      .toEqual({ card: 120 });
    expect(parseComponentHeightOverrides("not json")).toEqual({});
    expect(serializeComponentHeightOverrides({ second: 160, first: 80 }))
      .toBe('{"first":80,"second":160}');
  });

  test("prunes removed and organizational component caps", () => {
    const root = node("group", "layout", node("card"));
    expect(pruneComponentHeightOverrides({ group: 80, card: 120, removed: 200 }, root))
      .toEqual({ card: 120 });
  });
});
