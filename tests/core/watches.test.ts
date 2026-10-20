import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadProjectDefinition, ProjectRuntime, TrustStore } from "../../src/core";
import { parseComponentManifest } from "../../src/core/yaml";
import type { ComponentNode, DashboardConfig, NodeWatch, ResolvedComponentNode } from "../../src/shared/contracts";
import { watchSummaries } from "../../src/shared/watches";
import { childEdges } from "../../src/shared/child-edges";
import { createProject, installCoreFixture, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const cleanup: string[] = [];
const runtimes: ProjectRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

const STATUS = "./components/external/core/status";
const LIST = "./components/external/core/list";

function status(id: string, watch: unknown, source: Record<string, unknown> = { shell: "echo '{\"state\":\"healthy\"}'" }): ComponentNode {
  return { id, component: STATUS, props: { label: id.toUpperCase(), source }, watch: watch as NodeWatch };
}

function dashboard(nodes: ComponentNode[], name = "Watched"): DashboardConfig {
  return {
    schemaVersion: 4,
    name,
    root: {
      id: "root",
      component: "./components/external/core/tabs",
      children: nodes.map((node) => ({ node, metadata: { label: node.id ?? "Tab" } })),
    },
  };
}

async function project(config: DashboardConfig): Promise<string> {
  const root = await temporaryDirectory();
  cleanup.push(root);
  await createProject(root, config);
  return root;
}

function find(tree: ResolvedComponentNode | null, id: string): ResolvedComponentNode | undefined {
  if (!tree) return undefined;
  if (tree.id === id) return tree;
  for (const edge of childEdges(tree.children)) {
    const found = find(edge.node, id);
    if (found) return found;
  }
  return undefined;
}

function codes(definition: { diagnostics: Array<{ code: string }> }): string[] {
  return definition.diagnostics.map((item) => item.code);
}

describe("node watch contract", () => {
  test("keeps a valid watch on the resolved node and requests background:watch for it", async () => {
    const root = await project(dashboard([
      status("ci", { on: ["error"], every: 120000, action: { name: "Fix", run: "agent:prompt", with: { prompt: "Fix CI" } } }),
      status("plain", undefined),
    ]));
    const definition = await loadProjectDefinition(root);
    expect(definition.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(definition.ok).toBeTrue();
    expect(find(definition.tree, "ci")?.watch).toEqual({ on: ["error"], every: 120000, action: { name: "Fix", run: "agent:prompt", with: { prompt: "Fix CI" } } });
    expect(find(definition.tree, "plain")?.watch).toBeUndefined();
    expect(definition.permissionsByNode.get("ci")).toEqual(new Set(["background:watch", "process:execute"]));
    expect(definition.permissionsByNode.get("plain")).toEqual(new Set(["process:execute"]));
    expect(definition.permissions).toContain("background:watch");
    expect(watchSummaries(definition.tree)).toEqual([expect.objectContaining({
      nodeId: "ci",
      label: "CI",
      on: ["error"],
      every: 120000,
      level: "interrupt",
      action: "Fix",
      description: "runs echo '{\"state\":\"healthy\"}' every 2 min",
    })]);
  });

  test("rejects mixed families and unwatchable sources, including process sources", async () => {
    const root = await project(dashboard([
      status("mixed", { on: ["error", "added"] }),
      status("inline", { on: ["error"] }, { inline: { state: "error" } }),
      { id: "static", component: STATUS, props: { label: "Static", state: "healthy" }, watch: { on: ["error"] } },
      { id: "run-qa", component: "./components/external/core/command", props: { label: "QA", command: "true" } },
      status("from-process", { on: ["error"] }, { process: "run-qa" }),
    ]));
    const definition = await loadProjectDefinition(root);
    const invalid = definition.diagnostics.filter((item) => item.code === "COMPONENT_WATCH_INVALID");
    // Sibling nodes resolve concurrently, so diagnostics arrive in any order.
    expect(invalid).toHaveLength(4);
    expect(invalid.map((item) => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("cannot mix status states"),
      expect.stringContaining("inline source never changes"),
      expect.stringContaining("needs props.source"),
      expect.stringContaining("needs no watch"),
    ]));
    expect(definition.ok).toBeFalse();
    // Watch diagnostics never hide capability declarations.
    expect(definition.trustReview.available).toBeTrue();
    expect(definition.permissions).toContain("background:watch");
  });

  test("schema errors in a watch keep trust review available", async () => {
    const root = await project(dashboard([status("fast", { on: ["error"], every: 1000, extra: true })]));
    const definition = await loadProjectDefinition(root);
    expect(codes(definition)).toContain("CONFIG_SCHEMA_INVALID");
    expect(definition.ok).toBeFalse();
    expect(definition.trustReview.available).toBeTrue();
    expect(definition.permissions).toContain("background:watch");
  });

  test("validates the watch action like any action reference", async () => {
    const root = await project(dashboard([
      status("unknown-target", { on: ["error"], action: { name: "Show", run: "reveal:missing" } }),
      status("status-template", { on: ["error"], action: { name: "Ask", run: "agent:prompt", with: { prompt: "${item.title}" } } }),
      {
        id: "backlog",
        component: LIST,
        props: { title: "Backlog", source: { shell: "echo '[]'" } },
        watch: { on: ["added"], action: { name: "Ask", run: "agent:prompt", with: { prompt: "${item.title}" } } },
      },
      {
        id: "embedded",
        component: LIST,
        props: { title: "Embedded", source: { shell: "echo '[]'" } },
        watch: { on: ["added"], action: { name: "Ask", run: "agent:prompt", with: { prompt: "Look at ${item.title}" } } },
      },
    ]));
    const definition = await loadProjectDefinition(root);
    const errors = definition.diagnostics.filter((item) => item.severity === "error");
    expect(errors).toHaveLength(3);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COMPONENT_WATCH_INVALID", path: expect.stringContaining(".watch.action.with") }),
      expect.objectContaining({ code: "COMPONENT_ACTION_REFERENCE_UNKNOWN", path: "unknown-target.watch.action" }),
      expect.objectContaining({ code: "COMPONENT_ACTION_ARGUMENTS_INVALID", path: "embedded.watch.action.with" }),
    ]));
  });

  test("limits each bundle to ten watches", async () => {
    const nodes = Array.from({ length: 11 }, (_, index) => status(`w${index}`, { on: ["error"] }));
    const definition = await loadProjectDefinition(await project(dashboard(nodes)));
    const limit = definition.diagnostics.find((item) => item.code === "COMPONENT_WATCH_LIMIT");
    expect(limit?.path).toBe("w10.watch");
    expect(definition.ok).toBeFalse();
    expect(definition.trustReview.available).toBeTrue();
  });

  test("namespaces a linked bundle's watch action and rejects watches on config links", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 4,
      name: "Base",
      root: {
        component: "./components/external/core/tabs",
        children: [
          { node: { id: "personal", component: "./arvid" }, metadata: { label: "Personal" } },
          { node: { id: "watched-link", component: "./arvid", watch: { on: ["error"] } }, metadata: { label: "Again" } },
        ],
      },
    });
    const named = join(root, ".dash-bored", "arvid");
    await mkdir(join(named, "components"), { recursive: true });
    await installCoreFixture(named);
    await Promise.all([
      writeFile(join(named, "dash-bored.yaml"), stringify(dashboard([
        status("ci", { on: ["error"], action: { name: "Show target", run: "reveal:target" } }),
        { id: "target", component: STATUS, props: { label: "Target", state: "healthy" } },
      ], "Arvid"))),
      writeFile(join(named, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} })),
    ]);
    const definition = await loadProjectDefinition(root);
    expect(definition.diagnostics.filter((item) => item.severity === "error").map((item) => item.code)).toEqual(["COMPONENT_WATCH_INVALID"]);

    // The same bundle without the invalid link resolves and remaps the linked action.
    const config = definition.config!;
    (config.root.children as Array<{ node: ComponentNode }>).splice(1, 1);
    await writeFile(join(root, ".dash-bored", "dash-bored.yaml"), stringify(config));
    const linked = await loadProjectDefinition(root);
    expect(linked.ok).toBeTrue();
    const watched = find(linked.tree, "personal::ci");
    expect(watched?.watch?.action?.run).toBe("reveal:personal%3A%3Atarget");
    expect(watched?.sourceConfigPath).toBe(join(await realpath(named), "dash-bored.yaml"));
    expect(linked.permissions).toContain("background:watch");
    // The parent bundle owns none of the linked watches.
    expect(watchSummaries(linked.tree, linked.location.configPath)).toEqual([]);
    expect(watchSummaries(linked.tree).map((item) => item.nodeId)).toEqual(["personal::ci"]);
  });

  test("component manifests cannot declare background:watch", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const file = join(root, "component.yaml");
    await writeFile(file, stringify({
      schemaVersion: 3,
      apiVersion: "1.0.0",
      id: "sneaky",
      name: "Sneaky",
      description: "Claims background work",
      entry: "./index.tsx",
      propsSchema: { type: "object" },
      permissions: ["background:watch"],
    }));
    const parsed = await parseComponentManifest(file);
    expect(parsed.value).toBeNull();
    expect(parsed.diagnostics.map((item) => item.code)).toEqual(["MANIFEST_SCHEMA_INVALID"]);
  });
});

describe("watch trust", () => {
  test("adding the first watch to a trusted project requires approval again", async () => {
    const root = await project(dashboard([status("ci", undefined)]));
    const trustStore = new TrustStore(join(root, ".state", "trust.json"));
    const runtime = new ProjectRuntime({ trustStore });
    runtimes.push(runtime);
    await runtime.load(root);
    const trusted = await runtime.trust();
    expect(trusted.trusted).toBeTrue();
    expect(trusted.requestedPermissions).not.toContain("background:watch");

    const configPath = join(root, ".dash-bored", "dash-bored.yaml");
    await writeFile(configPath, stringify(dashboard([status("ci", { on: ["error"] })])));
    const reloaded = await runtime.reload();
    expect(reloaded.requestedPermissions).toContain("background:watch");
    expect(reloaded.trusted).toBeFalse();

    const definition = await loadProjectDefinition(root);
    expect(await runtime.isDefinitionTrusted(definition)).toBeFalse();
    const approved = await runtime.trust();
    expect(approved.trusted).toBeTrue();
    expect(await runtime.isDefinitionTrusted(definition)).toBeTrue();
    expect((await trustStore.getGrant(root))?.permissions).toContain("background:watch");

    await runtime.revoke();
    // Session revocation applies to every caller of the composed rule.
    await trustStore.trust(definition.location.projectRoot, definition.permissions);
    expect(await runtime.isDefinitionTrusted(definition)).toBeFalse();
  });

  test("an inspectable but unreviewable definition is never trusted", async () => {
    const root = await project(dashboard([status("ci", { on: ["error"] })]));
    const runtime = new ProjectRuntime({ trustStore: new TrustStore(join(root, ".state", "trust.json"), { automatic: true }) });
    runtimes.push(runtime);
    const definition = await loadProjectDefinition(root);
    expect(await runtime.isDefinitionTrusted(definition)).toBeTrue();
    expect(await runtime.isDefinitionTrusted({ ...definition, trustReview: { available: false, hasLocalCode: false } })).toBeFalse();
  });
});
