import { describe, expect, test } from "bun:test";
import type { ComponentManifest, LocalComponentHost } from "../../src/shared/contracts";
import { decodeSourceText, readDashboardSource } from "../../src/renderer/lib/source";
import { permissionsForComponent } from "../../src/shared/component-permissions";

const host = (value: Partial<LocalComponentHost>) => value as LocalComponentHost;

describe("dashboard sources", () => {
  test("decodes JSON and preserves plain text", () => {
    expect(decodeSourceText('{"ok":true}')).toEqual({ ok: true });
    expect(decodeSourceText("plain text")).toBe("plain text");
  });

  test("reads project script JSON through the bounded shell capability", async () => {
    let request: unknown;
    const value = await readDashboardSource(
      { shell: "bun run dashboard-data", cwd: ".dash-bored", timeoutMs: 4000, env: { CI: "1" } },
      host({ shell: { async run(input) { request = input; return { exitCode: 0, signal: null, stdout: '{"state":"healthy"}', stderr: "", timedOut: false }; } } }),
    );
    expect(value).toEqual({ state: "healthy" });
    expect(request).toEqual({ command: "bun run dashboard-data", cwd: ".dash-bored", timeoutMs: 4000, env: { CI: "1" } });
  });

  test("returns supervised process state and does not confuse it with request success", async () => {
    const snapshot = { id: "run-qa", phase: "exited" as const, pid: null, exitCode: 2, signal: null, logs: [] };
    expect(await readDashboardSource({ process: "run-qa" }, host({ processes: { get: (id) => id === "run-qa" ? snapshot : undefined } }))).toEqual(snapshot);
  });

  test("keeps stderr excerpt when a script fails and rejects missing capability", async () => {
    await expect(readDashboardSource({ shell: "false" }, host({ shell: { async run() { return { exitCode: 1, signal: null, stdout: "", stderr: `detail ${"x".repeat(600)}`, timedOut: false }; } } }))).rejects.toThrow(/Command failed \(exit 1\):/);
    await expect(readDashboardSource({ process: "missing" }, host({}))).rejects.toThrow("process:observe");
  });

  test("requires exactly one source kind", async () => {
    await expect(readDashboardSource({ inline: 1, file: "a.json" }, host({}))).rejects.toThrow("exactly one");
  });

  test("requests only the capability activated by the selected source", () => {
    const manifest: Pick<ComponentManifest, "permissions" | "permissionsByProp"> = { permissionsByProp: {
      path: ["filesystem:read", "filesystem:write"],
      "source.shell": ["process:execute"],
      "source.file": ["filesystem:read"],
      "source.http": ["network:http"],
      "source.process": ["process:observe"],
    } };
    expect(permissionsForComponent(manifest, { source: { inline: { ok: true } } })).toEqual([]);
    expect(permissionsForComponent(manifest, { path: "guide.md" })).toEqual(["filesystem:read", "filesystem:write"]);
    expect(permissionsForComponent(manifest, { source: { shell: "bun run data" } })).toEqual(["process:execute"]);
    expect(permissionsForComponent(manifest, { source: { process: "run-qa" } })).toEqual(["process:observe"]);
  });
});
