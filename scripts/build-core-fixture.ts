import { discoverPackageTemplates } from "../src/core/package-templates";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { coreManifests, coreReference } from "./core-package-fixture";
import { compileLocalComponents } from "../src/core/compiler";
import { loadLocalDefinition } from "../src/core/tree-catalog";
import { resolveProjectLocation } from "../src/core/paths";

// The renderer fixture uses the public resolver and compiler too. Never give
// core a broader import boundary than an ordinary installed package receives.
const location = await resolveProjectLocation(resolve(import.meta.dirname, ".."));
const definitions = [];
for (const manifest of coreManifests) {
  const loaded = await loadLocalDefinition(location, coreReference(manifest.id));
  if (!loaded.definition || loaded.diagnostics.length) throw new Error(JSON.stringify(loaded.diagnostics));
  definitions.push(loaded.definition);
}
const result = await compileLocalComponents(definitions);
if (result.diagnostics.length) throw new Error(JSON.stringify(result.diagnostics));
const out = resolve(import.meta.dirname, "../.cottontail-tmp/core-fixture.json");
await mkdir(resolve(out, ".."), {recursive: true});
await Bun.write(out, JSON.stringify({ manifests: coreManifests, components: result.components, templates: await discoverPackageTemplates(location) }));
