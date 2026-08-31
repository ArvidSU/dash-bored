import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ComponentChildLayout, ResolvedComponentNode } from "../../src/shared/contracts";
import { layoutStructureKey } from "../../src/renderer/component-children";
import {
  clampSplitRatioForSize,
  collectResizableSplitDefaults,
  effectiveSplitRatio,
  normalizeSplitRatio,
  normalizeVerticalSplitSize,
  parseSplitRatioOverrides,
  pruneSplitRatioOverrides,
  serializeSplitRatioOverrides,
  splitRatioOverridesStorageKey,
} from "../../src/renderer/split-layout";

function leaf(id: string): ComponentChildLayout<ResolvedComponentNode> {
  return {
    type: "child",
    child: { node: { id, component: "@dash-bored/text", props: {}, source: "builtin" } },
  };
}

function tree(): ResolvedComponentNode {
  return {
    id: "root",
    component: "@dash-bored/group",
    props: {},
    source: "builtin",
    children: {
      type: "tiled",
      layout: {
        type: "split",
        axis: "horizontal",
        ratio: 0.4,
        first: leaf("first"),
        second: {
          type: "split",
          axis: "vertical",
          ratio: 0.6,
          first: leaf("top"),
          second: leaf("bottom"),
        },
      },
    },
  };
}

describe("core tiled split sizing", () => {
  test("normalizes and clamps ratios for either axis", () => {
    expect(normalizeSplitRatio(undefined)).toBe(0.5);
    expect(normalizeSplitRatio(0.02)).toBe(0.1);
    expect(normalizeSplitRatio(1.2)).toBe(0.9);
    expect(clampSplitRatioForSize(0.05, 1_000, 200, 300)).toBe(0.202);
    expect(clampSplitRatioForSize(0.95, 1_000, 200, 300)).toBe(0.696);
    expect(clampSplitRatioForSize(0.2, 300, 240, 160)).toBe(0.2);
    expect(normalizeVerticalSplitSize(320.4)).toBe(320);
    expect(normalizeVerticalSplitSize(12)).toBeUndefined();
  });

  test("contains constrained vertical content with neutral, handle-free separators", async () => {
    const styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    const splitLayout = await readFile(new URL("../../src/renderer/SplitLayout.tsx", import.meta.url), "utf8");

    expect(styles).toMatch(/\.split--vertical \.split__pane\s*\{[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.split--vertical\.split--content-sized \.split__pane\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.split-container\s*\{[^}]*height:\s*auto;/s);
    expect(styles).toMatch(/\.split\s*\{[^}]*height:\s*auto;/s);
    expect(styles).toMatch(/\.split--vertical\.split--ratio-sized\s*\{[^}]*max-height:\s*100%;/s);
    expect(styles).toContain(".split--horizontal > .split__separator");
    expect(styles).not.toContain(".split--horizontal .split__separator");
    expect(styles).not.toContain("split__separator-handle");
    expect(styles).not.toMatch(/\.split__separator-line[^}]*background:\s*var\(--accent\)/s);
    expect(splitLayout).not.toContain("split__separator-handle");
  });

  test("round-trips bounded per-dashboard overrides and rejects malformed entries", () => {
    const overrides = {
      "root:second": { ratio: 0.66, defaultRatio: 0.6 },
      "root:root": { ratio: 0.34, defaultRatio: 0.4, verticalSize: 480 },
    };
    expect(parseSplitRatioOverrides(serializeSplitRatioOverrides(overrides))).toEqual(overrides);
    expect(parseSplitRatioOverrides("not json")).toEqual({});
    expect(parseSplitRatioOverrides(JSON.stringify({
      valid: { ratio: 0.4, defaultRatio: 0.5 },
      validVertical: { ratio: 0.4, defaultRatio: 0.5, verticalSize: 320 },
      invalidRatio: { ratio: 2, defaultRatio: 0.5 },
      invalidVertical: { ratio: 0.4, defaultRatio: 0.5, verticalSize: 12 },
    }))).toEqual({
      valid: { ratio: 0.4, defaultRatio: 0.5 },
      validVertical: { ratio: 0.4, defaultRatio: 0.5, verticalSize: 320 },
    });
    expect(splitRatioOverridesStorageKey("/project/one/dash-bored.yaml"))
      .not.toBe(splitRatioOverridesStorageKey("/project/two/dash-bored.yaml"));
  });

  test("uses an override only while its project default still matches", () => {
    expect(effectiveSplitRatio(0.4, { ratio: 0.7, defaultRatio: 0.4 })).toBe(0.7);
    expect(effectiveSplitRatio(0.45, { ratio: 0.7, defaultRatio: 0.4 })).toBe(0.45);
  });

  test("keys every nested layout branch independently and prunes stale defaults", () => {
    expect(collectResizableSplitDefaults(tree())).toEqual(new Map([
      ["root:root", 0.4],
      ["root:second", 0.6],
    ]));
    expect(pruneSplitRatioOverrides({
      "root:root": { ratio: 0.3, defaultRatio: 0.4 },
      "root:second": { ratio: 0.7, defaultRatio: 0.5 },
      removed: { ratio: 0.5, defaultRatio: 0.5 },
    }, tree())).toEqual({
      "root:root": { ratio: 0.3, defaultRatio: 0.4 },
    });
  });

  test("changes the topology key when insertion changes a split branch", () => {
    const original: ComponentChildLayout<ResolvedComponentNode> = {
      type: "split",
      axis: "vertical",
      ratio: 0.5,
      first: leaf("top"),
      second: leaf("bottom"),
    };
    const inserted: ComponentChildLayout<ResolvedComponentNode> = {
      type: "split",
      axis: "vertical",
      ratio: 0.5,
      first: leaf("top"),
      second: {
        type: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: leaf("new"),
        second: leaf("bottom"),
      },
    };
    expect(layoutStructureKey(original)).not.toBe(layoutStructureKey(inserted));
    expect(layoutStructureKey({ ...original, ratio: 0.7 })).toBe(layoutStructureKey(original));

    const nestedPanel: ResolvedComponentNode = {
      id: "panel",
      component: "@dash-bored/text",
      props: {},
      source: "builtin",
    };
    const nestedPanelEdge = { node: nestedPanel };
    const nestedChildEdge = {
      node: {
        id: "nested",
        component: "@dash-bored/text",
        props: {},
        source: "builtin" as const,
      },
    };
    const nestedOriginal: ComponentChildLayout<ResolvedComponentNode> = {
      type: "split",
      axis: "vertical",
      ratio: 0.5,
      first: leaf("top"),
      second: { type: "child", child: nestedPanelEdge },
    };
    const nestedInserted: ComponentChildLayout<ResolvedComponentNode> = {
      ...nestedOriginal,
      second: {
        type: "child",
        child: {
          ...nestedPanelEdge,
          node: {
            ...nestedPanel,
            children: { type: "managed", items: [nestedChildEdge] },
          },
        },
      },
    };
    expect(layoutStructureKey(nestedOriginal)).not.toBe(layoutStructureKey(nestedInserted));
  });
});
