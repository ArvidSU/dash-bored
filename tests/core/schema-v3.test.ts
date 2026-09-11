import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { ProjectRuntime, TrustStore } from "../../src/core";
import { validateDashboardConfigValue } from "../../src/core/yaml";
import type { DashboardConfig } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

const leaf = { node: { component: "@dash-bored/markdown", props: { content: "Ready" } } };
const config = (children: unknown) => ({
  schemaVersion: 3, name: "Compact topology", root: { component: "@dash-bored/group", children },
});

describe("dashboard schema v3", () => {
  test("validates deep split chains without recursively trying both axes", () => {
    let layout: unknown = leaf;
    for (let index = 0; index < 32; index++) {
      layout = { axis: index % 2 === 0 ? "horizontal" : "vertical", first: leaf, second: layout };
    }
    expect(validateDashboardConfigValue(config(layout))).toEqual([]);
  });

  test("accepts only unambiguous edges, managed lists, and explicit split branches", () => {
    for (const children of [leaf, [leaf], { axis: "horizontal", first: leaf, second: leaf }, { axis: "vertical", first: leaf, second: leaf }]) {
      expect(validateDashboardConfigValue(config(children))).toEqual([]);
    }
    for (const children of [
      { ...leaf, axis: "horizontal", first: leaf, second: leaf },
      { axis: "vertical", ratio: 0.5, first: leaf, second: leaf },
      { axis: "horizontal", ratio: 0.95, first: leaf, second: leaf },
      { axis: "horizontal", first: leaf },
      { type: "tiled", layout: { type: "child", child: leaf } },
      { type: "managed", items: [leaf] },
      { ...leaf, misspelledMetadata: {} },
    ]) {
      expect(validateDashboardConfigValue(config(children)).length).toBeGreaterThan(0);
    }
  });

  test("saves the same compact tree it loads, preserving metadata, grouping, and omitted defaults", async () => {
    const root = await temporaryDirectory();
    directories.push(root);
    await createProject(root);
    const configPath = join(root, ".dash-bored", "dash-bored.yaml");
    const authored: DashboardConfig = {
      schemaVersion: 3,
      name: "Compact topology",
      root: {
        id: "tabs", component: "@dash-bored/tabs",
        children: [{
          metadata: { label: "Work" },
          node: {
            id: "work", component: "@dash-bored/group",
            children: {
              axis: "horizontal", first: structuredClone(leaf),
              second: { axis: "vertical", first: structuredClone(leaf), second: structuredClone(leaf) },
            },
          },
        }],
      },
    };
    await writeFile(configPath, stringify(authored));
    const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, "trust.json")) });
    try {
      const loaded = await runtime.load(root);
      expect(loaded.diagnostics.filter(item => item.severity === "error")).toEqual([]);
      const source = await runtime.getDashboardConfigSource();
      expect(source.config).toEqual(authored);
      const saved = await runtime.saveDashboardConfig({ ...source.config, name: "Renamed" }, source.configRevision);
      expect(saved.config?.root).toEqual(authored.root);
      expect(parse(await readFile(configPath, "utf8"))).toEqual({ ...authored, name: "Renamed" });
      const children = saved.tree?.children;
      if (!Array.isArray(children)) throw new Error("Expected managed children");
      const layout = children[0]!.node.children;
      if (!layout || Array.isArray(layout) || !("axis" in layout) || !("node" in layout.first)) throw new Error("Expected split");
      expect(layout.first.node.sourcePath).toBe("root.children[0].node.children.first.node");
      expect(layout.first.node.id).toBe("root.children.0.children.0");
    } finally {
      await runtime.close();
    }
  });
});
