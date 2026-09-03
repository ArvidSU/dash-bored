import { describe, expect, test } from "bun:test";
import type { ComponentCatalogItem, ComponentManifest } from "../../src/shared/contracts";
import {
  buildExternalAddCommand,
  buildExternalRemoveCommand,
  buildExternalSyncCommand,
  buildExternalUpdateCommand,
  componentCatalogParity,
  componentProvenanceLabel,
  externalComponentInfo,
  filterComponentCatalog,
  isExternalCatalogItem,
  partitionCatalogByExternal,
  shortExternalPin,
  validateExternalComponentInput,
} from "../../src/renderer/lib/component-library";

function testManifest(overrides: Partial<ComponentManifest> & Pick<ComponentManifest, "id" | "name">): ComponentManifest {
  return {
    schemaVersion: 2,
    description: "Test component",
    entry: "./index.tsx",
    propsSchema: {},
    ...overrides,
  };
}

/** Stub external item shaped like the fixed shared contract (source "external"). */
function externalItem(
  reference: string,
  external: { url?: string; commit?: string; path?: string; updateAvailable?: boolean; initialized?: boolean },
  overrides: Partial<ComponentCatalogItem> = {},
): ComponentCatalogItem {
  return {
    reference,
    // Core discovery may not exist in this checkout yet; cast defensively like the flyout does.
    source: "external" as ComponentCatalogItem["source"],
    available: true,
    manifest: testManifest({ id: "stub-external", name: "Stub external" }),
    diagnostics: [],
    ...overrides,
    external,
  } as unknown as ComponentCatalogItem;
}

function builtinItem(reference: string): ComponentCatalogItem {
  return {
    reference,
    source: "builtin",
    available: true,
    manifest: testManifest({ id: "group", name: "Group" }),
    diagnostics: [],
  };
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("external components flyout contract", () => {
  test("partitions stub source:external items into the External section", () => {
    const catalog = [
      builtinItem("@dash-bored/group"),
      externalItem("./components/external/clock", { url: "https://example.com/clock.git", commit: COMMIT }),
    ];
    const { internal, external } = partitionCatalogByExternal(catalog);
    expect(internal.map((entry) => entry.reference)).toEqual(["@dash-bored/group"]);
    expect(external.map((entry) => entry.reference)).toEqual(["./components/external/clock"]);
    expect(isExternalCatalogItem(catalog[1]!)).toBe(true);
    expect(isExternalCatalogItem(catalog[0]!)).toBe(false);
  });

  test("search finds externals by URL and pin", () => {
    const catalog = [
      builtinItem("@dash-bored/group"),
      externalItem("./components/external/clock", { url: "https://github.com/acme/clock.git", commit: COMMIT }),
    ];
    expect(filterComponentCatalog(catalog, "github.com/acme").map((entry) => entry.reference))
      .toEqual(["./components/external/clock"]);
    expect(filterComponentCatalog(catalog, COMMIT.slice(0, 7)).map((entry) => entry.reference))
      .toEqual(["./components/external/clock"]);
    expect(filterComponentCatalog(catalog, "components/external").map((entry) => entry.reference))
      .toEqual(["./components/external/clock"]);
  });

  test("labels external provenance and counts parity without renaming existing fields", () => {
    const catalog = [
      builtinItem("@dash-bored/group"),
      externalItem("./components/external/clock", { url: "https://example.com/clock.git", commit: COMMIT }),
    ];
    expect(componentProvenanceLabel(catalog[1]!)).toBe("External");
    expect(componentProvenanceLabel(catalog[0]!)).toBe("Packaged");
    expect(componentCatalogParity(catalog)).toMatchObject({
      total: 2,
      packaged: 1,
      projectLocal: 0,
      external: 1,
      dashboardLinks: 0,
    });
  });

  test("add dialog accepts an empty name but rejects bad URLs, names, and refs", () => {
    expect(validateExternalComponentInput({ url: "https://example.com/clock.git" }).ok).toBe(true);
    expect(validateExternalComponentInput({ url: "https://example.com/clock.git", name: "" }).ok).toBe(true);
    expect(validateExternalComponentInput({ url: "git@github.com:acme/clock.git" }).ok).toBe(true);
    const badUrl = validateExternalComponentInput({ url: "not a url" });
    expect(badUrl.ok).toBe(false);
    expect(badUrl.errors.url).toBeString();
    const emptyUrl = validateExternalComponentInput({ url: "  " });
    expect(emptyUrl.ok).toBe(false);
    const badName = validateExternalComponentInput({ url: "https://example.com/c.git", name: "../escape" });
    expect(badName.ok).toBe(false);
    expect(badName.errors.name).toBeString();
    const badRef = validateExternalComponentInput({ url: "https://example.com/c.git", ref: "has space" });
    expect(badRef.ok).toBe(false);
    expect(badRef.errors.ref).toBeString();
  });

  test("previews the exact CLI commands with one-click copy text", () => {
    expect(buildExternalAddCommand({ url: "https://example.com/clock.git" }))
      .toBe("dash-bored component add https://example.com/clock.git");
    expect(buildExternalAddCommand({ url: "https://example.com/clock.git", name: "clock", ref: "main" }))
      .toBe("dash-bored component add https://example.com/clock.git --name clock --ref main");
    expect(buildExternalUpdateCommand("clock")).toBe("dash-bored component update clock");
    expect(buildExternalUpdateCommand("clock", "abc1234")).toBe("dash-bored component update clock --to abc1234");
    expect(buildExternalRemoveCommand("clock")).toBe("dash-bored component remove clock");
    expect(buildExternalSyncCommand()).toBe("dash-bored component sync");
  });

  test("reads pin details defensively and flags uninitialized checkouts for the Sync hint", () => {
    const ready = externalItem("./components/external/clock", {
      url: "https://example.com/clock.git",
      commit: COMMIT,
      updateAvailable: true,
    });
    const info = externalComponentInfo(ready)!;
    expect(info).toMatchObject({
      name: "clock",
      url: "https://example.com/clock.git",
      commit: COMMIT,
      path: "components/external/clock",
      updateAvailable: true,
      initialized: true,
    });
    expect(shortExternalPin(COMMIT)).toBe(COMMIT.slice(0, 7));
    // Top-level stub shape (no nested `external` object) also resolves.
    const flat = {
      reference: "./components/external/flat",
      source: "external",
      available: false,
      manifest: testManifest({ id: "flat", name: "Flat" }),
      diagnostics: [],
      url: "https://example.com/flat.git",
      pin: COMMIT,
    } as unknown as ComponentCatalogItem;
    expect(externalComponentInfo(flat)?.commit).toBe(COMMIT);
    const missing = externalItem("./components/external/empty", { url: "https://example.com/empty.git" }, { available: false });
    expect(externalComponentInfo(missing)?.initialized).toBe(false);
    expect(externalComponentInfo(builtinItem("@dash-bored/group"))).toBeNull();
  });

  test("treats core-shaped externals (pin in lock, not on the item) as initialized", () => {
    const coreItem: ComponentCatalogItem = {
      reference: "./components/external/clock",
      source: "external" as ComponentCatalogItem["source"],
      available: true,
      manifest: testManifest({ id: "clock", name: "Clock" }),
      diagnostics: [],
    };
    const info = externalComponentInfo(coreItem)!;
    expect(info.initialized).toBe(true);
    expect(info.name).toBe("clock");
    expect(filterComponentCatalog([coreItem], "components/external").map((entry) => entry.reference))
      .toEqual(["./components/external/clock"]);
  });
});
