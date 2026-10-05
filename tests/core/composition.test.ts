import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { inspectProject } from "../../src/core";
import { referenceLocations } from "../../src/core/tree-links";
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

const edge = (node: ComponentNode, metadata?: Record<string, unknown>) => ({ node, ...(metadata === undefined ? {} : { metadata }) });

describe("component child composition", () => {
  test("transitionally resolves schema-v3 action paths within the owning bundle", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const todoPath = "root.children[2].node.children.first.first.node.children.node";
    await createProject(root, {
      schemaVersion: 4,
      name: "Action paths",
      root: {
        component: "./components/external/core/tabs",
        persistOnFocus: true,
        children: [
          edge({ id: "focus-button", component: "./components/external/core/button", props: { name: "Focus todos", action: `focus:\${${todoPath}}` } }, { label: "Button" }),
          edge({ component: "./components/external/core/markdown", props: { content: "Spacer" } }, { label: "Spacer" }),
          edge({
            component: "./components/external/core/group",
            children: {
              axis: "horizontal",
              first: {
                axis: "horizontal",
                first: edge({
                  component: "./components/external/core/group",
                  children: edge({ id: "yaml-todo", component: "./components/external/core/todo-list", props: { todos: [] } }),
                }),
                second: edge({ component: "./components/external/core/status", props: { label: "Ready", state: "healthy" } }),
              },
              second: edge({ component: "./components/external/core/markdown", props: { content: "Notes" } }),
            },
          }, { label: "Overview" }),
        ],
      },
    });
    const result = await inspectProject(root);
    expect(result.ok).toBeTrue();
    expect(result.tree?.persistOnFocus).toBeTrue();
    const first = Array.isArray(result.tree?.children) ? result.tree.children[0]?.node : undefined;
    expect(first?.props.action).toBe("focus:yaml-todo");

    const configPath = join(root, ".dash-bored", "dash-bored.yaml");
    const invalid = structuredClone(result.config!);
    if (Array.isArray(invalid.root.children)) {
      invalid.root.children[0]!.node.props = { name: "Focus todos", action: "focus:${root.children[9].node}" };
    }
    await writeFile(configPath, stringify(invalid));
    const missing = await inspectProject(root);
    expect(missing.diagnostics.map((item) => item.code)).toContain("COMPONENT_ACTION_REFERENCE_INVALID");
  });

  test("transitionally resolves paths to generated node IDs", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 4,
      name: "Generated action target",
      root: {
        component: "./components/external/core/group",
        children: {
          axis: "horizontal",
          first: edge({ component: "./components/external/core/button", props: { name: "Focus status", action: "focus:${root.children.second.node}" } }),
          second: edge({ component: "./components/external/core/status", props: { label: "Status", state: "healthy" } }),
        },
      },
    });
    const result = await inspectProject(root);
    expect(result.ok).toBeTrue();
    const first = result.tree?.children;
    if (!first || Array.isArray(first) || !("axis" in first)) throw new Error("Expected split layout");
    expect((first.first as { node: { props: Record<string, unknown> } }).node.props.action)
      .toBe("focus:root.children.1");
  });

  test("rejects stable action references to unknown node IDs", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 4,
      name: "Unknown action target",
      root: {
        component: "./components/external/core/group",
        children: [
          edge({ id: "action-button", component: "./components/external/core/button", props: { name: "Missing target", action: "focus:missing-target" } }),
          edge({ id: "actual-target", component: "./components/external/core/markdown", props: { content: "Target" } }),
        ],
      },
    });
    const result = await inspectProject(root);
    expect(result.diagnostics.some((item) => item.code === "COMPONENT_ACTION_REFERENCE_UNKNOWN" && item.message.includes("missing-target"))).toBeTrue();
  });
  test("resolves recursive tiled topology and attaches built-in manifests", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const config: DashboardConfig = {
        schemaVersion: 4,
        name: "Tiles",
        root: {
            component: "./components/external/core/group",
            children: {
                axis: "horizontal",
                ratio: 0.42,
                first: edge({ component: "./components/external/core/markdown", props: { content: "First" } }),
                second: {
                    axis: "vertical",
                    first: edge({ component: "./components/external/core/markdown", props: { content: "Second" } }),
                    second: edge({ component: "./components/external/core/markdown", props: { content: "Third" } })
                }
            }
        }
    };
    await createProject(root, config);

    const result = await inspectProject(root);

    expect(result.ok).toBeTrue();
    expect(result.tree?.manifest?.id).toBe("core/group");
    expect(Array.isArray(result.tree?.children)).toBeFalse();
    if (result.tree?.children === undefined || Array.isArray(result.tree.children)) throw new Error("Expected tiled children");
    expect(result.tree.children).toMatchObject({
        axis: "horizontal",
        ratio: 0.42
    });
    if (!("axis" in result.tree.children)) throw new Error("Expected split layout");
    expect(result.tree.children.first).toMatchObject({
        node: {
            id: "root.children.0",
            sourcePath: "root.children.first.node",
            manifest: { id: "core/markdown" }
        }
    });
  });

  test("validates managed cardinality and per-child metadata generically", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
        schemaVersion: 4,
        name: "Empty tabs",
        root: {
            component: "./components/external/core/tabs",
            children: []
        }
    });
    const empty = await inspectProject(root);
    expect(empty.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_CARDINALITY",
    );

    await createProject(root, {
        schemaVersion: 4,
        name: "Tiled tabs",
        root: {
            component: "./components/external/core/tabs",
            children: edge({ component: "./components/external/core/markdown", props: { content: "One" } }, { label: "One" })
        }
    });
    const wrongPresentation = await inspectProject(root);
    expect(wrongPresentation.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_PRESENTATION_INVALID",
    );

    await createProject(root, {
        schemaVersion: 4,
        name: "Tabs",
        root: {
            component: "./components/external/core/tabs",
            props: { defaultTab: 99 },
            children: [{ node: { component: "./components/external/core/markdown", props: { content: "One" } } }]
        }
    });

    const invalid = await inspectProject(root);
    expect(invalid.diagnostics.map((item) => item.code)).toContain(
      "COMPONENT_CHILD_METADATA_INVALID",
    );
    expect(invalid.diagnostics.map((item) => item.code)).not.toContain("TABS_DEFAULT_INVALID");

    await createProject(root, {
        schemaVersion: 4,
        name: "Tabs",
        root: {
            component: "./components/external/core/tabs",
            props: { defaultTab: 99 },
            children: [{
                    node: { component: "./components/external/core/markdown", props: { content: "One" } },
                    metadata: { label: "One" }
                }]
        }
    });
    const valid = await inspectProject(root);
    expect(valid.ok).toBeTrue();
  });

  test("requires cards to group at least two tiled children", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 4,
      name: "One-child card",
      root: {
        component: "./components/external/core/card",
        children: edge({ component: "./components/external/core/markdown", props: { content: "Only child" } }),
      },
    });

    const invalid = await inspectProject(root);
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({
      code: "COMPONENT_CHILD_CARDINALITY",
      message: "Card requires at least 2 children.",
    }));

    await createProject(root, {
      schemaVersion: 4,
      name: "Paired card",
      root: {
        component: "./components/external/core/card",
        children: {
          axis: "vertical",
          first: edge({ component: "./components/external/core/markdown", props: { content: "First child" } }),
          second: edge({ component: "./components/external/core/status", props: { label: "Second child", state: "healthy" } }),
        },
      },
    });

    expect((await inspectProject(root)).ok).toBeTrue();
  });

  test("validates manifest cardinality, presentation, and allowed tiled axes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, ".dash-bored", "components", "horizontal-pair");
    await createProject(root, {
        schemaVersion: 4,
        name: "Axes",
        root: {
            component: "./components/horizontal-pair",
            children: {
                axis: "vertical",
                first: edge({ component: "./components/external/core/markdown", props: { content: "One" } }),
                second: {
                    axis: "horizontal",
                    ratio: 0.5,
                    first: edge({ component: "./components/external/core/markdown", props: { content: "Two" } }),
                    second: edge({ component: "./components/external/core/markdown", props: { content: "Three" } })
                }
            }
        }
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
    await writeFile(join(root, ".dash-bored", "dash-bored.yaml"), stringify({
        schemaVersion: 4,
        name: "Ratio",
        root: {
            component: "./components/external/core/group",
            children: {
                axis: "horizontal",
                ratio: 0.95,
                first: edge({ component: "./components/external/core/markdown", props: { content: "One" } })
            }
        }
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

  test("validates manifest action declarations and args schemas", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const directory = join(root, "manifests");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "actions.yaml");
    const base = {
      schemaVersion: 2,
      id: "actions",
      name: "Actions",
      description: "Declared action test.",
      entry: "./index.tsx",
      propsSchema: { type: "object" },
    };
    await writeFile(file, stringify({
      ...base,
      actions: [{ id: "refresh", label: "Refresh", args: {
        type: "object",
        properties: { force: { type: "boolean" } },
      } }],
    }));
    expect((await parseComponentManifest(file)).value?.actions).toEqual([{
      id: "refresh",
      label: "Refresh",
      args: { type: "object", properties: { force: { type: "boolean" } } },
    }]);

    await writeFile(file, stringify({
      ...base,
      actions: [{ id: "refresh", label: "Refresh" }, { id: "refresh", label: "Again" }],
    }));
    expect((await parseComponentManifest(file)).diagnostics.map((item) => item.code))
      .toContain("MANIFEST_ACTION_ID_DUPLICATE");
  });

  test("treats each item under a trailing star as a reference", async () => {
    const props = { actions: ["focus:a", "focus:b"] };
    const locations = referenceLocations(props, "actions.*");
    expect(locations.map(({ key, path }) => [key, path])).toEqual([["0", "actions.0"], ["1", "actions.1"]]);
    for (const { parent, key } of locations) parent[key] = `${String(parent[key])}-moved`;
    expect(props.actions).toEqual(["focus:a-moved", "focus:b-moved"]);

    const root = await temporaryDirectory();
    cleanup.push(root);
    const listDirectory = join(root, ".dash-bored", "components", "action-list");
    const workerDirectory = join(root, ".dash-bored", "components", "worker");
    await createProject(root, {
      schemaVersion: 4,
      name: "Trailing star references",
      root: {
        component: "./components/external/core/group",
        children: [
          edge({ id: "list", component: "./components/action-list", props: { actions: ["component:worker:refresh", "component:worker:typo"] } }),
          edge({ id: "worker", component: "./components/worker" }),
        ],
      },
    });
    await Promise.all([mkdir(listDirectory, { recursive: true }), mkdir(workerDirectory, { recursive: true })]);
    const common = { schemaVersion: 2, description: "Test component", entry: "./index.tsx", propsSchema: { type: "object" } };
    await Promise.all([
      writeFile(join(listDirectory, "component.yaml"), stringify({
        ...common,
        id: "action-list",
        name: "Action list",
        propsSchema: { type: "object", properties: { actions: { type: "array", items: { type: "string" } } } },
        references: { "actions.*": { resource: "action" } },
      })),
      writeFile(join(workerDirectory, "component.yaml"), stringify({
        ...common,
        id: "worker",
        name: "Worker",
        actions: [{ id: "refresh", label: "Refresh" }],
      })),
      writeFile(join(listDirectory, "index.tsx"), "export default () => null;"),
      writeFile(join(workerDirectory, "index.tsx"), "export default () => null;"),
    ]);

    const unknown = (await inspectProject(root)).diagnostics
      .filter((item) => item.code === "COMPONENT_ACTION_REFERENCE_UNKNOWN");
    expect(unknown).toEqual([expect.objectContaining({ path: "list.props.actions.1" })]);
  });

  test("rejects component action references missing from the target manifest", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const buttonDirectory = join(root, ".dash-bored", "components", "action-button");
    const workerDirectory = join(root, ".dash-bored", "components", "worker");
    await createProject(root, {
      schemaVersion: 4,
      name: "Action reference validation",
      root: {
        component: "./components/external/core/group",
        children: [
          edge({ component: "./components/action-button", props: { action: "component:worker:typo" } }),
          edge({ id: "worker", component: "./components/worker" }),
        ],
      },
    });
    await Promise.all([
      mkdir(buttonDirectory, { recursive: true }),
      mkdir(workerDirectory, { recursive: true }),
    ]);
    const common = { schemaVersion: 2, description: "Test component", entry: "./index.tsx", propsSchema: { type: "object" } };
    await Promise.all([
      writeFile(join(buttonDirectory, "component.yaml"), stringify({
        ...common,
        id: "action-button",
        name: "Action button",
        propsSchema: { type: "object", properties: { action: { type: "string" } } },
        references: { action: { resource: "action" } },
      })),
      writeFile(join(workerDirectory, "component.yaml"), stringify({
        ...common,
        id: "worker",
        name: "Worker",
        actions: [{ id: "refresh", label: "Refresh" }],
      })),
      writeFile(join(buttonDirectory, "index.tsx"), "export default () => null;"),
      writeFile(join(workerDirectory, "index.tsx"), "export default () => null;"),
    ]);

    const result = await inspectProject(root);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
      message: expect.stringContaining("typo"),
    }));
  });
});
