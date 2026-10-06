import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkComponentDirectory, setupComponentAuthoring } from "../../src/core/component-authoring";

const cli = resolve(import.meta.dirname, "../../src/cli/index.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn({ cmd: [process.execPath, cli, ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("component authoring CLI", () => {
  test("reports the selected versioned API metadata as JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-api-"));
    temporaryDirectories.push(cwd);

    const result = await run(cwd, "component", "api", "--api-version", "1.0.0", "--json");
    expect(result.exitCode).toBe(0);
    const metadata = JSON.parse(result.stdout);
    expect(metadata.apiVersion).toBe("1.0.0");
    expect(metadata).toHaveProperty("appVersion");
    expect(metadata.supportedTargets).toContain("1.0.0");
    expect(metadata.modules).toHaveProperty("@dash-bored/component");
    expect(metadata.modules).toHaveProperty("react");
    expect(metadata.sdkDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("init creates a permission-free schema-v3 starter that setup and check accept", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-init-"));
    const component = join(cwd, "focus-timer");
    temporaryDirectories.push(cwd);

    const result = await run(cwd, "component", "init", component);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("schemaVersion: 3");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("apiVersion: 1.0.0");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("id: focus-timer");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("permissions: []");
    expect(await readFile(join(component, "index.tsx"), "utf8")).toContain("useComponentVisibility");
    expect(await readFile(join(component, "index.tsx"), "utf8")).toContain("host.actions.register");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("id: start");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("id: pause");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toContain("id: reset");

    const setup = await setupComponentAuthoring(component);
    expect(setup).toBeTruthy();
    const checked = await checkComponentDirectory(component);
    expect(checked.ok).toBeTrue();
    expect(checked.apiVersion).toBe("1.0.0");
    expect(checked.stages.length).toBeGreaterThan(0);
    expect(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  test("init refuses to overwrite starter files and check failures use a nonzero status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-existing-"));
    const component = join(cwd, "component");
    temporaryDirectories.push(cwd);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(component, { recursive: true }));
    await writeFile(join(component, "component.yaml"), "keep this file\n", "utf8");

    const initialized = await run(cwd, "component", "init", component);
    expect(initialized.exitCode).toBe(1);
    expect(initialized.stderr).toContain("Refusing to overwrite existing file");
    expect(await readFile(join(component, "component.yaml"), "utf8")).toBe("keep this file\n");
    expect(await readFile(join(component, "index.tsx"), "utf8").catch(() => null)).toBeNull();

    const checked = await run(cwd, "component", "check", component, "--json");
    expect(checked.exitCode).not.toBe(0);
    const result = JSON.parse(checked.stdout || checked.stderr);
    expect(result.ok).toBeFalse();
  });

  test("the scaffold launcher bootstraps from an app tool or installed skill without PATH", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-launcher-"));
    temporaryDirectories.push(cwd);
    const component = join(cwd, "timer");
    expect((await run(cwd, "component", "init", component)).exitCode).toBe(0);
    const tool = join(cwd, "app tool");
    await writeFile(tool, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const skill = join(cwd, ".agents/skills/dash-bored/scripts");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "dash-bored"), '#!/bin/sh\nprintf "skill\\n"\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    for (const [toolPath, expected] of [[tool, "component\napi\n--json\n"], ["", "skill\ncomponent\napi\n--json\n"]]) {
      const child = Bun.spawn(["/bin/sh", "./dash-bored.sh", "component", "api", "--json"], {
        cwd: component, env: { ...process.env, HOME: cwd, CODEX_HOME: join(cwd, ".codex"), DASH_BORED_TOOL: toolPath, PATH: "/usr/bin:/bin" },
        stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe(expected!);
    }
    const readme = await readFile(join(component, "README.md"), "utf8");
    expect(readme).toContain("standalone-component-authoring");
    expect(readme).toContain("sh ./dash-bored.sh component setup .");
    expect(await Bun.file(join(component, ".dash-bored/dash-bored.yaml")).exists()).toBeFalse();
  });

  test("check reports a semantic TypeScript error with source location in JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-type-error-"));
    const component = join(cwd, "health-panel");
    temporaryDirectories.push(cwd);
    const initialized = await run(cwd, "component", "init", component);
    expect(initialized.exitCode).toBe(0);

    const sourcePath = join(component, "index.tsx");
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain("className=\"health-panel-timer\"");
    expect(source).toContain("return () => cleanups.forEach((cleanup) => cleanup())");
    expect(await readFile(join(component, "styles.css"), "utf8")).toContain(".health-panel-timer[data-phase=\"break\"]");
    const invalidSource = `${source}\nconst invalidType: string = 42;\n`;
    await writeFile(sourcePath, invalidSource, "utf8");
    const result = await run(cwd, "component", "check", component, "--json");

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    const error = report.diagnostics.find((item: { code: string; file?: string }) =>
      item.code === "COMPONENT_TYPESCRIPT_2322" && item.file?.endsWith("index.tsx"));
    expect(report.ok).toBeFalse();
    expect(error).toBeDefined();
    expect(error.line).toBe(invalidSource.split("\n").length - 1);
  });

  test("rejects unsupported API targets and invalid option combinations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dash-bored-component-options-"));
    const component = join(cwd, "status-panel");
    temporaryDirectories.push(cwd);

    const unsupported = await run(cwd, "component", "api", "--api-version", "99.0.0", "--json");
    expect(unsupported.exitCode).toBe(1);
    expect(JSON.parse(unsupported.stderr).error).toContain("unsupported");

    const invalidInit = await run(cwd, "component", "init", component, "--json");
    expect(invalidInit.exitCode).toBe(2);
    expect(invalidInit.stderr).toContain("does not accept --json");
    expect(await readFile(join(component, "component.yaml"), "utf8").catch(() => null)).toBeNull();

    const duplicate = await run(cwd, "component", "api", "--api-version", "1.0.0", "--api-version", "1.0.0");
    expect(duplicate.exitCode).toBe(2);
    expect(duplicate.stderr).toContain("may be specified only once");
  });
});
