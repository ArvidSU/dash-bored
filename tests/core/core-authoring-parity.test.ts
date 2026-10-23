import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { compileLocalComponents } from "../../src/core/compiler";
import { setupComponentAuthoring, checkComponentDirectory } from "../../src/core/component-authoring";
import { loadLocalDefinition, type LocalComponentDefinition } from "../../src/core/tree-catalog";
import type { ProjectLocation } from "../../src/core/paths";
import { ProjectRuntime, TrustStore } from "../../src/core";
import type { ProjectSnapshot } from "../../src/shared/contracts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const coreCheckout = resolve(import.meta.dirname, "../../.dash-bored/components/external/core");

async function copyWorkingCore(): Promise<{ root: string; packageDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "dash-bored-core-source-parity-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, ".dash-bored", "components", "external", "core");
  await mkdir(dirname(packageDirectory), { recursive: true });
  await cp(coreCheckout, packageDirectory, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", ".dash-bored-sdk", "dist"].includes(path.split("/").at(-1)!),
  });
  return { root, packageDirectory };
}

async function componentDirectories(packageDirectory: string): Promise<string[]> {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ["node_modules", "vendor", "shared", "scripts", "tests"].includes(entry.name)) continue;
    const directory = join(packageDirectory, entry.name);
    if (await Bun.file(join(directory, "component.yaml")).exists()) directories.push(directory);
  }
  return directories.sort();
}

async function loadDefinition(packageDirectory: string, componentDirectory: string): Promise<LocalComponentDefinition> {
  const configDirectory = dirname(dirname(dirname(packageDirectory)));
  const componentsDirectory = join(configDirectory, "components");
  const location: ProjectLocation = {
    projectRoot: dirname(configDirectory),
    configDirectory,
    configPath: join(configDirectory, "dash-bored.yaml"),
    lockPath: join(configDirectory, "dash-bored-lock.yaml"),
    componentsDirectory,
  };
  const reference = `./components/external/core/${relative(packageDirectory, componentDirectory).replaceAll("\\", "/")}`;
  const loaded = await loadLocalDefinition(location, reference);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.definition).not.toBeNull();
  return loaded.definition!;
}

test("fresh external core sources use the public SDK checker and reload source edits", async () => {
  const { packageDirectory } = await copyWorkingCore();
  expect(await Bun.file(join(packageDirectory, "node_modules")).exists()).toBeFalse();

  // Setup is the published authoring workflow. The checker itself reads the
  // shipped SDK in memory, so this also proves no app alias or dependency tree
  // is needed to check the package's editable TSX.
  const setup = await setupComponentAuthoring(packageDirectory);
  expect(await Bun.file(join(setup.sdkDirectory, "index.d.ts")).exists()).toBeTrue();
  const directories = await componentDirectories(packageDirectory);
  expect(directories.length).toBeGreaterThan(0);

  let hasSharedSourceImport = false;
  for (const directory of directories) {
    const manifest = parse(await readFile(join(directory, "component.yaml"), "utf8")) as {
      entry: string;
      sourceRoot?: string;
      types?: string;
    };
    expect(manifest.entry, relative(packageDirectory, directory)).toEndWith(".tsx");
    expect(manifest.sourceRoot, relative(packageDirectory, directory)).toBeDefined();
    expect(manifest.types, relative(packageDirectory, directory)).toBeUndefined();
    const entry = join(directory, manifest.entry.replace(/^\.\//, ""));
    const source = await readFile(entry, "utf8");
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const importedBase = resolve(dirname(entry), specifier!);
      const candidates = [importedBase, ...[".ts", ".tsx", ".js", ".css"].map((suffix) => `${importedBase}${suffix}`), ...["index.ts", "index.tsx", "index.js"].map((name) => join(importedBase, name))];
      let imported: string | undefined;
      for (const candidate of candidates) {
        if (await Bun.file(candidate).exists()) { imported = candidate; break; }
      }
      if (imported && !imported.startsWith(`${directory}/`) && imported.startsWith(`${packageDirectory}/`)) hasSharedSourceImport = true;
    }
    const result = await checkComponentDirectory(directory);
    expect(result.ok, `${relative(packageDirectory, directory)}: ${result.diagnostics.map((item) => item.message).join("; ")}`).toBeTrue();
    expect(result.stages.find((stage) => stage.name === "typescript-source")?.status).toBe("passed");
    expect(result.stages.find((stage) => stage.name === "production-bundle")?.status).toBe("passed");
  }
  expect(hasSharedSourceImport).toBeTrue();

  const groupDirectory = directories.find((directory) => directory.endsWith("/group"))!;
  const group = await loadDefinition(packageDirectory, groupDirectory);
  const before = await compileLocalComponents([group]);
  expect(before.diagnostics).toEqual([]);
  const original = await readFile(group.entryPath, "utf8");
  const edited = original.replace(/<(?!\/)([A-Za-z][\w.-]*)(?=[\s/>])/, '<$1 data-parity-revision="edited"');
  expect(edited).not.toBe(original);
  await writeFile(group.entryPath, edited);
  const after = await compileLocalComponents([group]);
  expect(after.diagnostics).toEqual([]);
  expect(after.components[0]?.revision).not.toBe(before.components[0]?.revision);

  await writeFile(group.entryPath, `import forbidden from "unbundled-core-parity-dependency";\n${edited}`);
  const rejected = await checkComponentDirectory(groupDirectory);
  expect(rejected.ok).toBeFalse();
  expect(rejected.diagnostics.some((item) => item.message.includes("unbundled-core-parity-dependency"))).toBeTrue();
}, 120_000);

test("the live project watcher recompiles an edited shared core source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-bored-core-watch-parity-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const configDirectory = join(projectRoot, ".dash-bored");
  const packageDirectory = join(configDirectory, "components", "external", "core");
  await cp(coreCheckout, packageDirectory, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", ".dash-bored-sdk", "dist"].includes(path.split("/").at(-1)!),
  });
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "dash-bored.yaml"), stringify({ schemaVersion: 4, name: "Core source watch", root: {
    id: "core-watch", component: "./components/external/core/group", props: { title: "Watched core" },
  } }));
  await writeFile(join(configDirectory, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} }));

  const snapshots: ProjectSnapshot[] = [];
  const runtime = new ProjectRuntime({
    trustStore: new TrustStore(join(root, "trust.json"), { automatic: true }),
    watchDebounceMs: 20,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  try {
    const initial = await runtime.load(projectRoot);
    expect(initial.trusted).toBeTrue();
    const beforeRevision = initial.components.find((item) => item.componentId === "core/group")?.revision;
    expect(beforeRevision).toBeDefined();
    runtime.watch();

    const sharedSource = join(packageDirectory, "shared", "shared.tsx");
    const original = await readFile(sharedSource, "utf8");
    const changed = original.replace('fallback = ""', 'fallback = "source-watch-edited"');
    expect(changed).not.toBe(original);
    await writeFile(sharedSource, changed);
    const reloaded = () => snapshots.some((snapshot) => snapshot.components.some(
      (component) => component.componentId === "core/group" && component.revision !== beforeRevision,
    ));
    for (let attempt = 0; attempt < 20 && !reloaded(); attempt += 1) {
      await writeFile(sharedSource, changed);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reloaded()).toBeTrue();
    expect(runtime.getSnapshot().components.find((item) => item.componentId === "core/group")?.revision).not.toBe(beforeRevision);
  } finally {
    await runtime.close();
  }
}, 45_000);
