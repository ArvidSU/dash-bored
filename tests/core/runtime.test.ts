import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { ProcessManager, ProjectRuntime, TrustStore } from "../../src/core";
import type {
  ComponentChildLayout,
  ComponentNode,
  DashboardConfig,
  ProjectSnapshot,
  ResolvedComponentNode,
} from "../../src/shared/contracts";
import {
  createProject,
  removeTemporaryDirectory,
  temporaryDirectory,
  waitFor,
  writeLocalComponent,
} from "./helpers";

const cleanup: string[] = [];
const managers: ProcessManager[] = [];
const runtimes: ProjectRuntime[] = [];

function child(node: ComponentNode): ComponentChildLayout {
  return { type: "child", child: { node } };
}

function tiled(nodes: readonly ComponentNode[]) {
  if (nodes.length === 1) return { type: "tiled" as const, layout: child(nodes[0]!) };
  return {
    type: "tiled" as const,
    layout: {
      type: "split" as const,
      axis: "vertical" as const,
      ratio: 0.5,
      first: child(nodes[0]!),
      second: child(nodes[1]!),
    },
  };
}

function resolvedChildren(node: ResolvedComponentNode | null | undefined): ResolvedComponentNode[] {
  const children = node?.children;
  if (children === undefined) return [];
  if (children.type === "managed") return children.items.map((edge) => edge.node);
  const nodes: ResolvedComponentNode[] = [];
  const visit = (layout: typeof children.layout): void => {
    if (layout.type === "child") nodes.push(layout.child.node);
    else {
      visit(layout.first);
      visit(layout.second);
    }
  };
  visit(children.layout);
  return nodes;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

describe("ProcessManager", () => {
  test("streams bounded output and retains an exited snapshot", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const manager = new ProcessManager({ projectRoot: root, maxLogBytes: 128 });
    managers.push(manager);
    await manager.reconcile([{ id: "hello", command: "printf 'hello'; printf 'warn' >&2" }]);

    await manager.start("hello");
    await waitFor(() => manager.get("hello")?.phase === "exited");
    const snapshot = manager.get("hello");
    expect(snapshot?.exitCode).toBe(0);
    expect(snapshot?.logs.some((entry) => entry.stream === "stdout" && entry.text.includes("hello"))).toBeTrue();
    expect(snapshot?.logs.some((entry) => entry.stream === "stderr" && entry.text.includes("warn"))).toBeTrue();
    expect(
      snapshot?.logs.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
    ).toBeLessThanOrEqual(128);
  });

  test("prevents duplicate runs, stops process trees, and reconciles changed definitions", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const manager = new ProcessManager({ projectRoot: root, stopGraceMs: 100 });
    managers.push(manager);
    await manager.reconcile([{ id: "server", command: "sleep 30" }]);
    await manager.start("server");
    await expect(manager.start("server")).rejects.toMatchObject({ code: "PROCESS_ALREADY_RUNNING" });
    const stopped = await manager.stop("server");
    expect(stopped.phase).toBe("exited");
    expect(stopped.signal).not.toBeNull();

    await manager.reconcile([{ id: "server", command: "printf changed" }]);
    expect(manager.get("server")?.phase).toBe("idle");
  });
});

describe("ProjectRuntime", () => {
  const processConfig: DashboardConfig = {
    schemaVersion: 2,
    name: "Runtime",
    root: {
      component: "@dash-bored/group",
      children: tiled([
        {
          id: "server",
          component: "@dash-bored/command",
          props: { label: "Server", command: "sleep 30" },
        },
        {
          id: "logs",
          component: "@dash-bored/terminal",
          props: { processId: "server" },
        },
      ]),
    },
  };

  test("gates processes on trust, keeps last-known-good state, and stops on revoke", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, processConfig);
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);

    const loaded = await runtime.load(root);
    expect(loaded.trusted).toBeFalse();
    expect(loaded.tree).not.toBeNull();
    await expect(runtime.startProcess("server")).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });

    const trusted = await runtime.trust();
    expect(trusted.trusted).toBeTrue();
    expect(trusted.processes.find((item) => item.id === "server")?.phase).toBe("idle");
    await runtime.startProcess("server");
    expect(runtime.getSnapshot().processes[0]?.phase).toBe("running");

    await writeFile(join(root, "dash-bored", "dash-bored.yaml"), "not: valid: yaml");
    const failedReload = await runtime.reload();
    expect(failedReload.tree).not.toBeNull();
    expect(failedReload.processes[0]?.phase).toBe("running");
    expect(failedReload.diagnostics.length).toBeGreaterThan(0);

    const revoked = await runtime.revoke();
    expect(revoked.trusted).toBeFalse();
    expect(revoked.components).toEqual([]);
    expect(revoked.processes).toEqual([]);
  });

  test("resolves a configured dashboard icon only after trust", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      ...processConfig,
      icon: "icon.svg",
    });
    await writeFile(
      join(root, "dash-bored", "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
    );
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);

    const restricted = await runtime.load(root);
    expect(restricted.iconDataUrl).toBeNull();

    const trusted = await runtime.trust();
    expect(trusted.iconDataUrl).toStartWith("data:image/svg+xml;base64,");

    await writeFile(join(root, "dash-bored", "icon.svg"), "not an image");
    const broken = await runtime.reload();
    expect(broken.tree).not.toBeNull();
    expect(broken.iconDataUrl).toBeNull();
  });

  test("watches project files and publishes a successful reload", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    const snapshots: ProjectSnapshot[] = [];
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
      watchDebounceMs: 20,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    runtimes.push(runtime);
    await runtime.load(root);
    runtime.watch();
    const changed = {
      schemaVersion: 2,
      name: "Changed",
      root: { component: "@dash-bored/text", props: { content: "updated" } },
    } as const;
    await writeFile(join(root, "dash-bored", "dash-bored.yaml"), stringify(changed));

    await waitFor(() => snapshots.some((snapshot) => snapshot.dashboardName === "Changed"));
    expect(runtime.getSnapshot().dashboardName).toBe("Changed");
  });

  test("unloads watchers and project state while keeping the runtime reusable", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    const snapshots: ProjectSnapshot[] = [];
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    runtimes.push(runtime);

    await runtime.load(root);
    runtime.watch();
    const unloaded = await runtime.unload();
    expect(unloaded.projectRoot).toBeNull();
    expect(unloaded.tree).toBeNull();
    expect(unloaded.processes).toEqual([]);
    expect(snapshots.at(-1)?.projectRoot).toBeNull();

    const reloaded = await runtime.load(root);
    expect(reloaded.projectRoot).toBe(await realpath(root));
    expect(reloaded.tree).not.toBeNull();
  });

  test("serializes revoke with reload and leaves capabilities disabled", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, processConfig);
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);
    await runtime.load(root);
    await runtime.trust();
    await runtime.startProcess("server");

    const reload = runtime.reload();
    const revoke = runtime.revoke();
    await Promise.all([reload, revoke]);
    expect(runtime.getSnapshot().trusted).toBeFalse();
    expect(runtime.getSnapshot().processes).toEqual([]);
    await expect(runtime.startProcess("server")).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
    });
  });

  test("creates and watches dashboard files below a selected project named dash-bored", async () => {
    const parent = await temporaryDirectory();
    cleanup.push(parent);
    const root = join(parent, "dash-bored");
    await mkdir(root);
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);
    const loaded = await runtime.load(root, { inputKind: "project-root" });

    expect(loaded.tree?.component).toBe("@dash-bored/group");
    expect((await stat(join(root, "dash-bored", "components"))).isDirectory()).toBeTrue();
    await expect(access(join(root, "dash-bored.yaml"))).rejects.toThrow();
    expect(() => runtime.watch()).not.toThrow();
    expect(runtime.getSnapshot().diagnostics).toEqual([]);
  });

  test("switches between canonical and named bundles in the same project", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 2,
      name: "Canonical",
      root: { component: "@dash-bored/text", props: { content: "Canonical" } },
    });
    const named = join(root, "dash-bored", "arvid");
    await mkdir(join(named, "components"), { recursive: true });
    await Promise.all([
      writeFile(
        join(named, "dash-bored.yaml"),
        stringify({
          schemaVersion: 2,
          name: "Arvid",
          root: { component: "@dash-bored/text", props: { content: "Personal" } },
        }),
      ),
      writeFile(
        join(named, "dash-bored-lock.yaml"),
        stringify({ lockfileVersion: 1, components: {} }),
      ),
    ]);

    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);

    expect((await runtime.load(root)).dashboardName).toBe("Canonical");
    const selected = await runtime.load(named);
    expect(selected.dashboardName).toBe("Arvid");
    expect(selected.tree?.props.content).toBe("Personal");
    expect(selected.diagnostics).toEqual([]);
  });

  test("validates and atomically saves a draft while rejecting stale or invalid writes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);
    const loaded = await runtime.load(root);
    const expectedRevision = loaded.configRevision!;
    expect((await runtime.validateComponentProps("@dash-bored/text", {})).ok).toBeFalse();
    expect((await runtime.validateComponentProps("@dash-bored/text", { content: "Valid" })).ok).toBeTrue();
    const changed: DashboardConfig = {
      ...loaded.config!,
      name: "Edited in app",
      root: {
        component: "@dash-bored/group",
        children: tiled([
          { id: "message", component: "@dash-bored/text", props: { content: "Saved" } },
        ]),
      },
    };

    expect((await runtime.validateDashboardDraft(changed)).ok).toBeTrue();
    const saved = await runtime.saveDashboardConfig(changed, expectedRevision);
    expect(saved.dashboardName).toBe("Edited in app");
    expect(saved.configRevision).not.toBe(expectedRevision);
    expect(await readFile(join(root, "dash-bored", "dash-bored.yaml"), "utf8")).toContain("Edited in app");
    expect((await readdir(join(root, "dash-bored"))).some((name) => name.endsWith(".tmp"))).toBeFalse();

    const sourceAfterSave = await readFile(join(root, "dash-bored", "dash-bored.yaml"), "utf8");
    await expect(runtime.saveDashboardConfig({ ...changed, name: "Stale" }, expectedRevision)).rejects.toMatchObject({
      code: "DASHBOARD_CONFIG_CONFLICT",
    });
    const invalid = structuredClone(changed);
    invalid.root = { component: "@dash-bored/text" };
    expect((await runtime.validateDashboardDraft(invalid)).ok).toBeFalse();
    await expect(runtime.saveDashboardConfig(invalid, saved.configRevision!)).rejects.toMatchObject({
      code: "DASHBOARD_DRAFT_INVALID",
    });
    expect(await readFile(join(root, "dash-bored", "dash-bored.yaml"), "utf8")).toBe(sourceAfterSave);
  });

  test("invalidates trust for newly requested permissions and preflights trusted local code", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    await writeLocalComponent(root, "broken", "this is not valid typescript !!!");
    const configPath = join(root, "dash-bored", "dash-bored.yaml");
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);
    await runtime.load(root);
    const trusted = await runtime.trust();
    expect(trusted.trusted).toBeTrue();

    const broken: DashboardConfig = {
      schemaVersion: 2,
      name: "Broken",
      root: { id: "broken", component: "./components/broken" },
    };
    const before = await readFile(configPath, "utf8");
    await expect(runtime.saveDashboardConfig(broken, trusted.configRevision!)).rejects.toMatchObject({
      code: "DASHBOARD_COMPONENT_COMPILE_FAILED",
    });
    expect(await readFile(configPath, "utf8")).toBe(before);

    const command: DashboardConfig = {
      schemaVersion: 2,
      name: "Command",
      root: {
        component: "@dash-bored/group",
        children: tiled([
          { id: "server", component: "@dash-bored/command", props: { label: "Run", command: "echo ok" } },
        ]),
      },
    };
    const saved = await runtime.saveDashboardConfig(command, trusted.configRevision!);
    expect(saved.trusted).toBeFalse();
    expect(saved.requestedPermissions).toEqual(["process:execute"]);
    expect(saved.processes).toEqual([]);
  });

  test("supervises a process declared by a project-local component manifest", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 2,
      name: "Local process resource",
      root: {
        id: "local-runner",
        component: "./components/local-runner",
        props: { command: "printf local-resource" },
      },
    });
    await writeLocalComponent(
      root,
      "local-runner",
      "export default function LocalRunner() { return null; }",
      {
        propsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: { command: { type: "string", minLength: 1 } },
        },
        permissions: ["process:execute"],
        resources: { process: { commandProp: "command" } },
      },
    );
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);

    const loaded = await runtime.load(root);
    expect(loaded.diagnostics).toEqual([]);
    const trusted = await runtime.trust();
    expect(trusted.processes.map((process) => process.id)).toEqual(["local-runner"]);
    const finished = await runtime.startProcess("local-runner");
    await waitFor(() => runtime.getSnapshot().processes[0]?.phase === "exited");
    expect(finished.id).toBe("local-runner");
    expect(runtime.getSnapshot().processes[0]?.logs.map((entry) => entry.text).join(""))
      .toContain("local-resource");
  });

  test("edits the standalone source that owns a focused linked component", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 2,
      name: "Base",
      root: { id: "personal", component: "./arvid" },
    });
    const named = join(root, "dash-bored", "arvid");
    await mkdir(join(named, "components"), { recursive: true });
    await Promise.all([
      writeFile(join(named, "dash-bored.yaml"), stringify({
        schemaVersion: 2,
        name: "Arvid",
        root: { component: "@dash-bored/text", props: { content: "Before" } },
      })),
      writeFile(join(named, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} })),
    ]);
    const baseSource = await readFile(join(root, "dash-bored", "dash-bored.yaml"), "utf8");
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
    });
    runtimes.push(runtime);
    const loaded = await runtime.load(root);
    const linkedRoot = resolvedChildren(loaded.tree)[0];
    expect(linkedRoot?.sourceConfigPath).toBe(await realpath(join(named, "dash-bored.yaml")));
    expect(linkedRoot?.sourcePath).toBe("root");

    const source = await runtime.getDashboardConfigSource(linkedRoot?.sourceConfigPath);
    const edited: DashboardConfig = {
      ...source.config,
      root: { component: "@dash-bored/text", props: { content: "After" } },
    };
    const saved = await runtime.saveDashboardConfig(
      edited,
      source.configRevision,
      source.configPath,
    );
    expect(resolvedChildren(saved.tree)[0]?.props.content).toBe("After");
    expect(await readFile(join(named, "dash-bored.yaml"), "utf8")).toContain("After");
    expect(await readFile(join(root, "dash-bored", "dash-bored.yaml"), "utf8")).toBe(baseSource);
  });
});
