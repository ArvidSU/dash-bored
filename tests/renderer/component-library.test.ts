import { describe, expect, test } from "bun:test";
import type { ComponentCatalogItem, ComponentManifest, Permission } from "../../src/shared/contracts";
import {
  componentCatalogParity,
  componentContractLabel,
  componentPermissionLabels,
  componentProvenanceLabel,
  filterComponentCatalog,
} from "../../src/renderer/component-library";

function item(
  reference: string,
  manifest: Partial<ComponentManifest> & Pick<ComponentManifest, "id" | "name">,
  options: Partial<Pick<ComponentCatalogItem, "source" | "available" | "diagnostics">> = {},
): ComponentCatalogItem {
  return {
    reference,
    source: options.source ?? "builtin",
    available: options.available ?? true,
    manifest: {
      schemaVersion: 2,
      description: "",
      entry: "./component",
      propsSchema: {},
      ...manifest,
    },
    diagnostics: options.diagnostics ?? [],
  };
}

const labels: Record<Permission, string> = {
  "filesystem:read": "Read files",
  "filesystem:write": "Write files",
  "network:http": "HTTP",
  "process:execute": "Run commands",
  "process:observe": "Observe processes",
  "webview:embed": "Embed web pages",
};

describe("component library catalog helpers", () => {
  const catalog = [
    item("@dash-bored/chart", {
      id: "@dash-bored/chart",
      name: "Chart",
      description: "Visualize metrics",
      children: { min: 1, max: 2, presentation: { type: "tiled", axes: "horizontal" } },
      permissions: ["network:http"],
    }),
    item("./components/notebook", {
      id: "local-notebook",
      name: "Notebook",
      description: "Write project notes",
      children: { min: 0, presentation: { type: "managed" } },
      permissions: ["filesystem:read", "filesystem:write"],
    }, { source: "local" }),
    item("./components/broken", {
      id: "broken",
      name: "Broken component",
      description: "Unavailable diagnostics",
    }, { source: "local", available: false, diagnostics: [{ severity: "error", code: "BROKEN", message: "Missing entry" }] }),
  ];
  const chart = catalog[0]!;
  const notebook = catalog[1]!;

  test("searches reference, name, description, child contract, and permission", () => {
    expect(filterComponentCatalog(catalog, "chart").map((entry) => entry.reference)).toEqual(["@dash-bored/chart"]);
    expect(filterComponentCatalog(catalog, "project notes").map((entry) => entry.reference)).toEqual(["./components/notebook"]);
    expect(filterComponentCatalog(catalog, "tiled horizontal").map((entry) => entry.reference)).toEqual(["@dash-bored/chart"]);
    expect(filterComponentCatalog(catalog, "network:http").map((entry) => entry.reference)).toEqual(["@dash-bored/chart"]);
    expect(filterComponentCatalog(catalog, "  NOTEBOOK ")).toEqual([notebook]);
  });

  test("keeps unavailable matching entries visible and preserves order", () => {
    expect(filterComponentCatalog(catalog, "missing entry").map((entry) => entry.reference)).toEqual(["./components/broken"]);
    expect(filterComponentCatalog(catalog, "").map((entry) => entry.reference)).toEqual(catalog.map((entry) => entry.reference));
  });

  test("summarizes packaged and local entries through the same manifest-shaped contract", () => {
    const packaged = item("@dash-bored/group", {
      id: "group",
      name: "Group",
      children: { min: 1, max: 3, presentation: { type: "tiled", axes: "both" } },
    });
    const local = item("./components/group", {
      id: "group-local",
      name: "Local group",
      children: { min: 1, max: 3, presentation: { type: "tiled", axes: "both" } },
    }, { source: "local" });
    expect(componentContractLabel(packaged)).toBe(componentContractLabel(local));
    expect(componentCatalogParity([packaged, local])).toMatchObject({
      total: 2,
      withManifest: 2,
      packaged: 1,
      projectLocal: 1,
      manifestShaped: 2,
      equivalentManifestShape: true,
    });
  });

  test("labels managed, tiled, and absent contracts and ordered permissions", () => {
    expect(componentContractLabel(item("none", { id: "none", name: "None" }))).toBe("no children");
    expect(componentContractLabel(chart)).toBe("min 1, max 2 · tiled horizontal");
    expect(componentContractLabel(notebook)).toBe("min 0, max unlimited · managed");
    expect(componentPermissionLabels(notebook, labels)).toEqual(["Read files", "Write files"]);
    expect(componentPermissionLabels(notebook, { "filesystem:write": "Write" })).toEqual(["Write"]);
    expect(componentProvenanceLabel(chart)).toBe("Packaged");
    expect(componentProvenanceLabel(notebook)).toBe("Project-local");
    expect(componentProvenanceLabel({ source: "config" })).toBe("Dashboard link");
  });
});
