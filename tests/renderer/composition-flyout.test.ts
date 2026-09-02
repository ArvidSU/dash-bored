import { describe, expect, test } from "bun:test";
import {
  parseComponentCatalogDragPayload,
  serializeComponentCatalogDragPayload,
} from "../../src/renderer/CompositionFlyout";
import {
  compositionPayloadFromDragEvent,
  compatibleCompositionDropZones as filterCompositionDropZones,
} from "../../src/renderer/composition-dnd";
import type { CompositionDropZone } from "../../src/renderer/composition-context";

describe("component library drag payloads", () => {
  test("round-trips a catalog reference without carrying component-specific state", () => {
    const encoded = serializeComponentCatalogDragPayload("@dash-bored/markdown");
    expect(parseComponentCatalogDragPayload(encoded)).toEqual({
      type: "component",
      reference: "@dash-bored/markdown",
    });
  });

  test("rejects malformed or empty browser drag data", () => {
    expect(parseComponentCatalogDragPayload("not json")).toBeNull();
    expect(parseComponentCatalogDragPayload(JSON.stringify({ type: "node", reference: "x" }))).toBeNull();
    expect(parseComponentCatalogDragPayload(JSON.stringify({ type: "component", reference: " " }))).toBeNull();
  });

  test("keeps an in-app drag payload when WebKit hides custom drag types", () => {
    const transfer = {
      types: [],
      getData: () => "",
    };
    expect(compositionPayloadFromDragEvent(transfer, {
      type: "component",
      reference: "@dash-bored/markdown",
    })).toEqual({ type: "component", reference: "@dash-bored/markdown" });
    expect(compositionPayloadFromDragEvent(transfer, null)).toBeNull();
  });

  test("filters invalid spatial zones before they reach the drag UI", () => {
    const validTarget = {
      parentPath: [],
      placement: { type: "managed" as const, index: 0 },
    };
    const invalidTarget = {
      parentPath: [],
      placement: { type: "managed" as const, index: 1 },
    };
    const zones: CompositionDropZone[] = [
      { id: "invalid", label: "Invalid", side: "left", target: invalidTarget },
      { id: "valid", label: "Valid", side: "right", target: validTarget },
    ];
    const payload = { type: "component" as const, reference: "@dash-bored/card" };

    expect(filterCompositionDropZones(zones, payload, (target) => target === validTarget))
      .toEqual([zones[1]!]);
    expect(filterCompositionDropZones(zones, null, () => false)).toEqual(zones);
  });
});
