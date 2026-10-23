import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { compileLocalComponents } from "../../src/core/compiler";
import { checkComponentDirectory } from "../../src/core/component-authoring";
import { prepareComponentDependency } from "../../src/core/component-prepare";
import { loadLocalDefinition } from "../../src/core/tree-catalog";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(sourceRoot?: string) {
  const root = await mkdtemp(join(tmpdir(), "dash-source-package-"));
  cleanup.push(root);
  const componentsDirectory = join(root, "components");
  const packageRoot = join(componentsDirectory, "external", "example");
  const directory = join(packageRoot, "panel");
  await mkdir(directory, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"private":true}');
  await writeFile(join(directory, "component.yaml"), stringify({ schemaVersion: 3, apiVersion: "2.0.0", id: "panel", name: "Panel", description: "Panel", entry: "./index.tsx", ...(sourceRoot === undefined ? {} : { sourceRoot }), propsSchema: { type: "object" } }));
  await writeFile(join(directory, "index.tsx"), 'import { label } from "../shared"; export default () => <div>{label}</div>;');
  await writeFile(join(packageRoot, "shared.ts"), 'export const label = "shared-first";');
  const location = { componentsDirectory, configDirectory: root, configPath: join(root, "dash-bored.yaml"), lockPath: join(root, "dash-bored-lock.yaml"), projectRoot: root };
  return { root, packageRoot, directory, load: () => loadLocalDefinition(location, "./components/external/example/panel") };
}

test("a declared package source root compiles shared editable TS and changes its revision", async () => {
  const f = await fixture("..");
  const loaded = await f.load();
  expect(loaded.diagnostics).toEqual([]);
  const before = await compileLocalComponents([loaded.definition!]);
  expect(before.diagnostics).toEqual([]);
  expect(before.components[0]!.javascript).toContain("shared-first");
  const checked = await checkComponentDirectory(f.directory);
  expect(checked.diagnostics).toEqual([]);
  expect(checked.ok).toBeTrue();
  await writeFile(join(f.packageRoot, "shared.ts"), 'export const label = "shared-second";');
  const after = await compileLocalComponents([loaded.definition!]);
  expect(after.components[0]!.revision).not.toBe(before.components[0]!.revision);
  expect(after.components[0]!.javascript).toContain("shared-second");
});

test("sharing requires an explicit source root and cannot escape its external package", async () => {
  const undeclared = await fixture();
  const loaded = await undeclared.load();
  expect((await compileLocalComponents([loaded.definition!])).diagnostics[0]!.message).toContain("outside the component directory");
  expect((await checkComponentDirectory(undeclared.directory)).diagnostics.some((item) => item.code === "COMPONENT_SOURCE_OUTSIDE_ROOT")).toBeTrue();
  const escaped = await fixture("../..");
  expect((await escaped.load()).definition).toBeNull();
});

test("declared roots and shared imports cannot escape through symlinks", async () => {
  const f = await fixture("..");
  const outside = join(f.root, "outside.ts");
  await writeFile(outside, 'export const label = "escaped";');
  await rm(join(f.packageRoot, "shared.ts"));
  await symlink(outside, join(f.packageRoot, "shared.ts"));
  const loaded = await f.load();
  expect((await compileLocalComponents([loaded.definition!])).diagnostics[0]!.message).toContain("outside the component directory");
  await symlink(f.root, join(f.directory, "escape"));
  const manifest = await readFile(join(f.directory, "component.yaml"), "utf8");
  await writeFile(join(f.directory, "component.yaml"), manifest.replace("sourceRoot: ..", "sourceRoot: ./escape"));
  expect((await f.load()).definition).toBeNull();
});

test("dependency preparation vendors browser code that ordinary TSX compilation can load without node_modules", async () => {
  const f = await fixture("..");
  const dependency = join(f.packageRoot, "node_modules", "sample-library");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"sample-library","main":"index.js"}');
  await writeFile(join(dependency, "index.js"), 'export { label, default } from "./implementation.js";');
  await writeFile(join(dependency, "implementation.js"), 'import React from "react"; export const label = React.createElement ? "vendored-label" : "missing"; export default label;');
  await prepareComponentDependency(f.packageRoot, { dependency: "sample-library", output: "vendor/sample.js" });
  const prepared = await readFile(join(f.packageRoot, "vendor/sample.js"), "utf8");
  expect(prepared).toContain("vendored-label");
  expect(prepared).toContain("as default");
  // Module labels are package-relative, so committed output does not depend on where prepare ran.
  expect(prepared).toContain("// node_modules/sample-library/implementation.js");
  expect(prepared).not.toContain(f.packageRoot);
  await rm(join(f.packageRoot, "node_modules"), { recursive: true });
  await writeFile(join(f.directory, "index.tsx"), 'import { label } from "../vendor/sample.js"; export default () => <div>{label}</div>;');
  const loaded = await f.load();
  const compiled = await compileLocalComponents([loaded.definition!]);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.components[0]!.javascript).toContain("vendored-label");
  expect(compiled.components[0]!.javascript).toContain("__DASH_BORED_COMPONENT_RUNTIME__");
  await expect(prepareComponentDependency(f.packageRoot, { dependency: "sample-library", output: "../../escape.js" })).rejects.toThrow();
});


test("dependency preparation preserves CommonJS default exports", async () => {
  const f = await fixture("..");
  const dependency = join(f.packageRoot, "node_modules", "common-library");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"common-library","main":"index.js"}');
  await writeFile(join(dependency, "index.js"), 'module.exports = function value() { return "common-default"; };');
  await prepareComponentDependency(f.packageRoot, { dependency: "common-library", output: "vendor/common.js" });
  const source = await readFile(join(f.packageRoot, "vendor/common.js"), "utf8");
  expect(source).toContain("common-default");
  expect(source).toContain("as default");
});


test("dashboard component check uses the runtime boundary ahead of repository authoring markers", async () => {
  const f = await fixture("../..");
  await writeFile(join(f.root, "dash-bored.yaml"), "schemaVersion: 4\n");
  await writeFile(join(f.root, "package.json"), '{"private":true}');
  const checked = await checkComponentDirectory(f.directory);
  expect(checked.ok).toBeFalse();
  expect(checked.diagnostics.some((item) => item.code === "PATH_OUTSIDE_PROJECT")).toBeTrue();
  // A project-local component cannot use the repository root as its source root either.
  const local = join(f.root, "components", "local");
  await mkdir(local);
  await writeFile(join(local, "component.yaml"), (await readFile(join(f.directory, "component.yaml"), "utf8")));
  await writeFile(join(local, "index.tsx"), "export default () => <div />;");
  const localChecked = await checkComponentDirectory(local);
  expect(localChecked.ok).toBeFalse();
  expect(localChecked.diagnostics.some((item) => item.code === "PATH_OUTSIDE_PROJECT")).toBeTrue();
});


test("dependency preparation selects browser package exports before scanning default exports", async () => {
  const f = await fixture("..");
  const dependency = join(f.packageRoot, "node_modules", "browser-library");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "browser-library", exports: { browser: "./browser.js", default: "./node.js" } }));
  await writeFile(join(dependency, "browser.js"), 'export default "selected-browser-export";');
  await writeFile(join(dependency, "node.js"), 'export const node = "wrong-node-export";');
  await prepareComponentDependency(f.packageRoot, { dependency: "browser-library", output: "vendor/browser.js" });
  const prepared = await readFile(join(f.packageRoot, "vendor/browser.js"), "utf8");
  expect(prepared).toContain("selected-browser-export");
  expect(prepared).toContain("as default");
  expect(prepared).not.toContain("wrong-node-export");
});


for (const extension of ["ts", "tsx", "jsx"] as const) {
  test(`dependency preparation accepts browser ${extension} entries`, async () => {
    const f = await fixture("..");
    const directory = join(f.packageRoot, "node_modules", "typed-browser-library");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "typed-browser-library", exports: { browser: `./index.${extension}` } }));
    const source = extension === "ts"
      ? 'export const caption: string = "typed-browser"; export default caption;'
      : `${extension === "tsx" ? 'const caption: string = "typed-browser";' : 'const caption = "typed-browser";'} export default function View() { return <span>{caption}</span>; }`;
    await writeFile(join(directory, `index.${extension}`), source);
    await prepareComponentDependency(f.packageRoot, { dependency: "typed-browser-library", output: "vendor/typed.js" });
    const prepared = await readFile(join(f.packageRoot, "vendor/typed.js"), "utf8");
    expect(prepared).toContain("typed-browser");
    expect(prepared).toContain("as default");
    expect(prepared).not.toContain(": string");
  });
}
