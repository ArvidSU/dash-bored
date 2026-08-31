import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { inspectProject } from "../../src/core";
import { parseComponentManifest } from "../../src/core/yaml";
import type { ComponentNode, DashboardConfig } from "../../src/shared/contracts";
import {
  createProject,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "./helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

const edge = (node: ComponentNode, metadata?: Record<string, unknown>) => ({
  type: "child" as const,
  child: { node, ...(metadata === undefined ? {} : { metadata }) },
});

describe("component child composition", () => {
  test("resolves recursive tiled topology and attaches built-in manifests", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const config: DashboardConfig = {
      schemaVersion: 2,
      name: "Tiles",
      root: {
        component: "@dash-bored/group",
        children: {
          type: "tiled",
          layout: {
            type: "split",
            axis: "horizontal",
            ratio: 0.42,
            first: edge({ component: "@dash-bored/text", props: { content: "First" } }),
            second: {
              type: "split",
              axis: "vertical",
              ratio: 0.6,
              first: edge({ component: "@dash-bored/text", props: { content: "Second" } }),
              second: edge({ component: "@dash-bored/text", props: { content: "Third" } }),
            },
          },
        },
      },
    };
    await createProject(root, config);

    const result = await inspectProject(root);

    expect(result.ok).toBeTrue();
    expect(result.tree?.manifest?.id).toBe("@dash-bored/group");
    expect(result.tree?.children?.type).toBe("tiled");
    if (result.tree?.children?.type !== "tiled") throw new Error("Expected tiled children");
    expect(result.tree.children.layout).toMatchObject({
      type: "split",
      axis: "horizontal",
      ratio: 0.42,
    });
    if (result.tree.children.layout.type !== "split") throw new Error("Expected split layout");
    expect(result.tree.children.layout.first).toMatchObject({
      type: "child",
      child: {
        node: {
          id: "root.children.0",
          sourcePath: "root.children.layout.first.child.node",
          manifest: { id: "@dash-bored/text" },
        },
      },
    });
  });

  test("validates managed cardinality and per-child metadata generically", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 2,
      name: "Empty tabs",
      root: {
        component: "@dash-bored/tabs",
        children: { type: "managed", items: [] },
      },
    });
    const empty = await inspectProject(root);
    expect(empty.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_CARDINALITY",
    );

    await createProject(root, {
      schemaVersion: 2,
      name: "Tiled tabs",
      root: {
        component: "@dash-bored/tabs",
        children: {
          type: "tiled",
          layout: edge(
            { component: "@dash-bored/text", props: { content: "One" } },
            { label: "One" },
          ),
        },
      },
    });
    const wrongPresentation = await inspectProject(root);
    expect(wrongPresentation.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_PRESENTATION_INVALID",
    );

    await createProject(root, {
      schemaVersion: 2,
      name: "Tabs",
      root: {
        component: "@dash-bored/tabs",
        props: { defaultTab: 99 },
        children: {
          type: "managed",
          items: [{ node: { component: "@dash-bored/text", props: { content: "One" } } }],
        },
      },
    });

    const invalid = await inspectProject(root);
    expect(invalid.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_METADATA_INVALID",
    );
    expect(invalid.diagnostics.map((item) => item.code)).not.toContain("TABS_DEFAULT_INVALID");

    await createProject(root, {
      schemaVersion: 2,
      name: "Tabs",
      root: {
        component: "@dash-bored/tabs",
        props: { defaultTab: 99 },
        children: {
          type: "managed",
          items: [{
            node: { component: "@dash-bored/text", props: { content: "One" } },
            metadata: { label: "One" },
          }],
        },
      },
    });
    const valid = await inspectProject(root);
    expect(valid.ok).toBeTrue();
  });

  test("validates manifest cardinality, presentation, and allowed tiled axes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, "dash-bored", "components", "horizontal-pair");
    await createProject(root, {
      schemaVersion: 2,
      name: "Axes",
      root: {
        component: "./components/horizontal-pair",
        children: {
          type: "tiled",
          layout: {
            type: "split",
            axis: "vertical",
            ratio: 0.5,
            first: edge({ component: "@dash-bored/text", props: { content: "One" } }),
            second: {
              type: "split",
              axis: "horizontal",
              ratio: 0.5,
              first: edge({ component: "@dash-bored/text", props: { content: "Two" } }),
              second: edge({ component: "@dash-bored/text", props: { content: "Three" } }),
            },
          },
        },
      },
    });
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "component.yaml"), stringify({
        schemaVersion: 2,
        id: "horizontal-pair",
        name: "Horizontal pair",
        description: "Two horizontal children.",
        entry: "./index.tsx",
        propsSchema: { type: "object", additionalProperties: false },
        children: {
          min: 2,
          max: 2,
          presentation: { type: "tiled", axes: "horizontal" },
        },
      })),
      writeFile(join(directory, "index.tsx"), "export default () => null;"),
    ]);

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("COMPONENT_CHILD_AXIS_INVALID");
    expect(result.diagnostics.map((item) => item.code)).toContain("COMPONENT_CHILD_CARDINALITY");
  });

  test("rejects malformed or out-of-bounds layout branches at the config schema", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    await writeFile(join(root, "dash-bored", "dash-bored.yaml"), stringify({
      schemaVersion: 2,
      name: "Ratio",
      root: {
        component: "@dash-bored/group",
        children: {
          type: "tiled",
          layout: {
            type: "split",
            axis: "horizontal",
            ratio: 0.95,
            first: edge({ component: "@dash-bored/text", props: { content: "One" } }),
          },
        },
      },
    }));

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("CONFIG_SCHEMA_INVALID");
  });

  test("requires declared permissions for app-owned resources and references", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, "manifests");
    await mkdir(directory, { recursive: true });
    const resourceManifest = join(directory, "resource.yaml");
    const referenceManifest = join(directory, "reference.yaml");
    const base = {
      schemaVersion: 2,
      name: "Local capability",
      description: "Exercises the public capability contract.",
      entry: "./index.tsx",
      propsSchema: { type: "object", additionalProperties: true },
    };
    await Promise.all([
      writeFile(resourceManifest, stringify({
        ...base,
        id: "resource",
        resources: { process: { commandProp: "command" } },
      })),
      writeFile(referenceManifest, stringify({
        ...base,
        id: "reference",
        references: { processId: { resource: "process" } },
      })),
    ]);

    expect((await parseComponentManifest(resourceManifest)).diagnostics.map((item) => item.code))
      .toContain("MANIFEST_RESOURCE_PERMISSION_MISSING");
    expect((await parseComponentManifest(referenceManifest)).diagnostics.map((item) => item.code))
      .toContain("MANIFEST_REFERENCE_PERMISSION_MISSING");
  });
});
