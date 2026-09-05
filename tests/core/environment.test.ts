import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { environmentSnapshot, mergeEnvironment, readBundleEnvironment } from "../../src/core/environment";
import { CapabilityService } from "../../src/core/capabilities";
import { ProcessManager } from "../../src/core/process-manager";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await Bun.$`rm -rf ${root}`;
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
    expect(process.env.DASH_BORED_AGENT).not.toBe("component command");
  });

  test("keeps named and linked bundle environment isolated", async () => {
    const first = await bundle("DASH_BORED_AGENT=first\n");
    const second = await bundle("DASH_BORED_AGENT=second\n");
    expect(await readBundleEnvironment(first)).toEqual({ DASH_BORED_AGENT: "first" });
    expect(await readBundleEnvironment(second)).toEqual({ DASH_BORED_AGENT: "second" });
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
