import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadProjectDefinition } from "../../src/core";
import type { DashboardConfig } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

const reference = await readFile(
  resolve(import.meta.dirname, "../../skills/dash-bored/references/components.md"),
  "utf8",
);
const blocks = [...reference.matchAll(/```(yaml|tsx|css)\n([\s\S]*?)\n```/g)]
  .map((match) => ({ language: match[1]!, source: match[2]! }));

async function exampleProject(config: DashboardConfig): Promise<string> {
  const root = await temporaryDirectory();
  cleanup.push(root);
  await createProject(root, config);
  return root;
}

describe("shipped component authoring examples", () => {
  test("complete dashboard YAML examples resolve and the worked local component compiles", async () => {
    const configs = blocks.filter((block) => block.language === "yaml")
      .map((block) => parse(block.source))
      .filter((value) => value.schemaVersion === 3 && value.root);
    expect(configs.length).toBeGreaterThan(0);

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
    const nodes = blocks.filter((block) => block.language === "yaml")
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
});
