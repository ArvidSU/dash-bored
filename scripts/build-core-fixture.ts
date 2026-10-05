import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { coreFixtureRoot, coreManifests, coreReference } from "./core-package-fixture";
import { compileLocalComponents } from "../src/core/compiler";
const definitions = coreManifests.map((manifest) => {
  const name = manifest.id.slice(5); const directory = resolve(coreFixtureRoot, name);
  return { manifest, directory, entryPath: resolve(directory, "index.tsx"), manifestPath: resolve(directory, "component.yaml"), reference: coreReference(name) };
});
const result = await compileLocalComponents(definitions);
if (result.diagnostics.length) throw new Error(JSON.stringify(result.diagnostics));
const out = resolve(import.meta.dirname, "../.cottontail-tmp/core-fixture.json");
await mkdir(resolve(out, ".."), {recursive: true});
await Bun.write(out, JSON.stringify({ manifests: coreManifests, components: result.components }));
