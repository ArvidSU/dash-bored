import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { environmentSnapshot, mergeEnvironment, readBundleEnvironment } from "../../src/core/environment";
import { CapabilityService } from "../../src/core/capabilities";
import { ProcessManager } from "../../src/core/process-manager";
import type { ResolvedComponentNode } from "../../src/shared/contracts";

const temporaryRoots: string[] = [];

function findLinkedNode(node: ResolvedComponentNode | null): ResolvedComponentNode | null {
  if (!node) return null;
  if (node.sourceConfigPath?.includes("/arvid/dash-bored.yaml")) return node;
  const children = node.children;
  if (!children) return null;
  if (children.type === "managed") {
    for (const item of children.items) {
      const found = findLinkedNode(item.node);
      if (found) return found;
    }
    return null;
  }
  const visit = (layout: typeof children.layout): ResolvedComponentNode | null => {
    if (layout.type === "child") return findLinkedNode(layout.child.node);
    return visit(layout.first) ?? visit(layout.second);
  };
  return visit(children.layout);
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function bundle(values: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dash-bored-env-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "dash-bored.yaml"), "name: test\nroot:\n  id: root\n  component: '@dash-bored/stack'\n", "utf8");
  await writeFile(join(root, ".env"), values, "utf8");
  return join(root, "dash-bored.yaml");
}

describe("environment contracts", () => {
  test("parses dotenv syntax as data and applies the documented precedence", async () => {
    const configPath = await bundle([
      "export DASH_BORED_AGENT='bundle command' # note",
      "QUOTED=\"hello\\\" world\"",
      "EMPTY=",
      "# retained comment",
    ].join("\n"));
    const parsed = await readBundleEnvironment(configPath);
    expect(parsed).toEqual({
      DASH_BORED_AGENT: "bundle command",
      QUOTED: 'hello" world',
      EMPTY: "",
    });

    const inherited = { DASH_BORED_AGENT: "process command", ONLY_PROCESS: "yes" };
    const published = { DASH_BORED_AGENT: "app command" };
    const explicit = { DASH_BORED_AGENT: "component command" };
    expect(mergeEnvironment(parsed, published, explicit, inherited)).toMatchObject({
      DASH_BORED_AGENT: "component command",
      ONLY_PROCESS: "yes",
    });
    expect(environmentSnapshot(parsed, published, explicit)).toEqual({
      values: [{ key: "DASH_BORED_AGENT", value: "component command", source: "component" }],
    });
    expect(environmentSnapshot(parsed, {}, {}, {})).toEqual({
      values: [{ key: "DASH_BORED_AGENT", value: "bundle command", source: "bundle" }],
    });
    expect(process.env.DASH_BORED_AGENT).not.toBe("component command");
  });

  test("keeps named and linked bundle environment isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "dash-bored-runtime-env-"));
    temporaryRoots.push(root);
    const dashboard = join(root, ".dash-bored");
    const named = join(dashboard, "arvid");
    await mkdir(join(named, "components"), { recursive: true });
    await writeFile(join(dashboard, ".env"), "DASH_BORED_AGENT=canonical\n", "utf8");
    await writeFile(join(named, ".env"), "DASH_BORED_AGENT=named\n", "utf8");
    await writeFile(join(dashboard, "dash-bored-lock.yaml"), "lockfileVersion: 1\ncomponents: {}\n", "utf8");
    await writeFile(join(named, "dash-bored-lock.yaml"), "lockfileVersion: 1\ncomponents: {}\n", "utf8");
    await writeFile(join(named, "dash-bored.yaml"), [
      "schemaVersion: 2",
      "name: Named",
      "root:",
      "  id: named-command",
      "  component: '@dash-bored/command'",
      "  props:",
      "    label: Named",
      "    command: 'sleep 30'",
    ].join("\n") + "\n", "utf8");
    await writeFile(join(dashboard, "dash-bored.yaml"), [
      "schemaVersion: 2",
      "name: Canonical",
      "root:",
      "  id: linked-bundle",
      "  component: ./arvid",
    ].join("\n") + "\n", "utf8");

    const { ProjectRuntime, TrustStore } = await import("../../src/core");
    const runtime = new ProjectRuntime({
      trustStore: new TrustStore(join(root, ".state", "trust.json")),
      getPublishedEnvironment: () => ({}),
    });
    try {
      const loaded = await runtime.load(root);
      const linked = await runtime.trust();
      const linkedNode = findLinkedNode(linked.tree);
      expect(loaded.diagnostics).toEqual([]);
      expect(linkedNode?.sourceConfigPath).toBe(await realpath(join(named, "dash-bored.yaml")));
      expect(linked.environmentByNode?.[linkedNode!.id]?.values[0]).toEqual({
        key: "DASH_BORED_AGENT", value: "named", source: "bundle",
      });
      const shell = await runtime.runShell({ nodeId: linkedNode!.id, command: "printf '%s' \"$DASH_BORED_AGENT\"" });
      expect(shell.stdout).toBe("named");
      await runtime.startProcess(linkedNode!.id);
      const runningPid = runtime.getSnapshot().processes.find((process) => process.id === linkedNode!.id)?.pid;
      expect(runningPid).toBeNumber();
      await writeFile(join(named, ".env"), "DASH_BORED_AGENT=refreshed\n", "utf8");
      const refreshed = await runtime.refreshEnvironment();
      expect(refreshed.environmentByNode?.[linkedNode!.id]?.values[0]?.value).toBe("refreshed");
      expect(runtime.getSnapshot().processes.find((process) => process.id === linkedNode!.id)?.pid).toBe(runningPid);
      const nextShell = await runtime.runShell({ nodeId: linkedNode!.id, command: "printf '%s' \"$DASH_BORED_AGENT\"" });
      expect(nextShell.stdout).toBe("refreshed");
      expect(await readFile(join(named, ".env"), "utf8")).toContain("refreshed");
    } finally {
      await runtime.close();
    }
  });

  test("passes environment precedence to real process and capability launches", async () => {
    const configPath = await bundle("DASH_BORED_AGENT=bundle\n");
    const manager = new ProcessManager({
      projectRoot: temporaryRoots[0]!,
      getPublishedEnvironment: () => ({ DASH_BORED_AGENT: "app", SHARED: "app" }),
    });
    await manager.reconcile([{
      id: "process",
      command: "printf '%s|%s' \"$DASH_BORED_AGENT\" \"$SHARED\"",
      configPath,
      env: { DASH_BORED_AGENT: "component" },
    }]);
    try {
      await manager.start("process");
      const deadline = Date.now() + 1_000;
      while (manager.get("process")?.phase === "running" && Date.now() < deadline) await Bun.sleep(5);
      expect(manager.get("process")?.phase).toBe("exited");
      expect(manager.get("process")?.logs.some((entry) => entry.text.includes("component|app"))).toBeTrue();
    } finally {
      await manager.close();
    }

    const capabilities = new CapabilityService();
    capabilities.configure({
      projectRoot: temporaryRoots[0]!,
      trusted: true,
      permissionsByNode: new Map([["shell", new Set(["process:execute"])]]),
      configPathsByNode: new Map([["shell", configPath]]),
      getPublishedEnvironment: () => ({ DASH_BORED_AGENT: "app", SHARED: "app" }),
    });
    const shell = await capabilities.runShell({
      nodeId: "shell",
      command: "printf '%s|%s' \"$DASH_BORED_AGENT\" \"$SHARED\"",
      env: { DASH_BORED_AGENT: "component" },
    });
    expect(shell.stdout).toBe("component|app");
  });
});
