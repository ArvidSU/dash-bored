import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadProjectDefinition } from "../../src/core";
import type { DashboardConfig } from "../../src/shared/contracts";
import { parseDashboardList } from "../../src/renderer/lib/list-data";
import { parseStatusValue } from "../../src/renderer/lib/view-shapes";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

const skillDirectory = resolve(import.meta.dirname, "../../skills/dash-bored");
type Block = { language: string; source: string };

async function codeBlocks(path: string): Promise<Block[]> {
  const text = await readFile(join(skillDirectory, path), "utf8");
  return [...text.matchAll(/```(yaml|tsx|css|sh|python)\n([\s\S]*?)\n```/g)]
    .map((match) => ({ language: match[1]!, source: match[2]! }));
}

const guidance = {
  "SKILL.md": await codeBlocks("SKILL.md"),
  "references/components.md": await codeBlocks("references/components.md"),
  "references/sources.md": await codeBlocks("references/sources.md"),
};
const blocks = guidance["references/components.md"];

async function exampleProject(config: DashboardConfig): Promise<string> {
  const root = await temporaryDirectory();
  cleanup.push(root);
  await createProject(root, config);
  return root;
}

describe("shipped component authoring examples", () => {
  test("complete dashboard YAML examples resolve and the worked local component compiles", async () => {
    const configs = Object.values(guidance).flat().filter((block) => block.language === "yaml")
      .map((block) => parse(block.source))
      .filter((value) => value.schemaVersion === 3 && value.root);
    expect(configs.length).toBeGreaterThan(1);

    for (const config of configs) {
      const root = await exampleProject(config);
      if (config.root.component === "./components/git-summary") {
        const directory = join(root, ".dash-bored/components/git-summary");
        await mkdir(directory, { recursive: true });
        const manifest = blocks.find((block) =>
          block.language === "yaml" && parse(block.source).id === "git-summary");
        const source = blocks.find((block) => block.language === "tsx" && block.source.includes("defineComponent<Props>"));
        const css = blocks.find((block) => block.language === "css");
        if (!manifest || !source || !css) throw new Error("The worked example is incomplete.");
        await Promise.all([
          writeFile(join(directory, "component.yaml"), manifest.source),
          writeFile(join(directory, "index.tsx"), source.source),
          writeFile(join(directory, "styles.css"), css.source),
        ]);
      }
      const result = await loadProjectDefinition(root, { compile: true });
      expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(result.ok).toBeTrue();
      if (config.root.component === "./components/git-summary") {
        expect(result.compiledComponents).toHaveLength(1);
        expect(result.compiledComponents[0]?.css?.length).toBeGreaterThan(0);
      }
    }
  });

  test("complete built-in node examples satisfy their real props and child schemas", async () => {
    const nodes = Object.values(guidance).flat().filter((block) => block.language === "yaml")
      .map((block) => parse(block.source))
      .filter((value) => typeof value.component === "string"
        && !JSON.stringify(value).includes("./components/"));
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const root = await exampleProject({ schemaVersion: 3, name: "Authoring example", root: node });
      const result = await loadProjectDefinition(root, { compile: true });
      expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(result.ok).toBeTrue();
    }
  });

  test("source script examples emit the shapes their views require", async () => {
    const scripts = guidance["references/sources.md"].filter((block) => block.language === "sh" || block.language === "python");
    const statusScript = scripts.find((block) => block.source.includes("@dash-bored/status source"));
    const listScript = scripts.find((block) => block.source.includes("@dash-bored/list source"));
    if (!statusScript || !listScript) throw new Error("The source script examples are incomplete.");

    const root = await temporaryDirectory();
    cleanup.push(root);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q");
    await writeFile(join(root, "README.md"), "# Example\n");
    git("add", "README.md");
    git("-c", "user.name=Example", "-c", "user.email=example@example.com", "commit", "-qm", "Quote \"subject\" \\ safely");
    const scriptDirectory = await temporaryDirectory();
    cleanup.push(scriptDirectory);
    const statusPath = join(scriptDirectory, "status.sh");
    const listPath = join(scriptDirectory, "list.py");
    await writeFile(statusPath, statusScript.source);
    await writeFile(listPath, listScript.source);

    const run = (command: string[]) => {
      const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()) as unknown;
    };
    expect(parseStatusValue(run(["/bin/sh", statusPath]))).toMatchObject({ state: "healthy" });
    await writeFile(join(root, "untracked.txt"), "change\n");
    expect(parseStatusValue(run(["/bin/sh", statusPath]))).toMatchObject({ state: "warning" });

    const list = parseDashboardList(run(["python3", listPath]));
    expect(list.diagnostics).toEqual([]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ title: "Quote \"subject\" \\ safely" });
    expect(typeof list.items[0]?.sha).toBe("string");
    expect(typeof list.items[0]?.prompt).toBe("string");
  });
});
