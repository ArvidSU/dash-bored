/** Read the pinned package for docs/tests; never a production component registry. */
import { CORE_PACKAGE } from "../src/shared/core-package";
import { checkedOutCommit } from "../src/core/package-store";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { ComponentManifest } from "../src/shared/contracts";
export const coreFixtureRoot = resolve(import.meta.dirname, "../.dash-bored/components/external/core");
if (await checkedOutCommit(coreFixtureRoot) !== CORE_PACKAGE.commit) throw new Error("Restore the release-pinned core package before generating references or fixtures.");
export function coreReference(name: string): string { return `./components/external/core/${name.replace(/^core\//, "")}`; }
export const coreManifests: ComponentManifest[] = [];
for (const name of (await readdir(coreFixtureRoot)).sort()) {
  const path = resolve(coreFixtureRoot, name, "component.yaml");
  if (await Bun.file(path).exists()) coreManifests.push(parse(await readFile(path, "utf8")) as ComponentManifest);
}
export function getCoreManifest(reference: string): ComponentManifest | undefined {
  const name = reference.slice(reference.lastIndexOf("/") + 1);
  return coreManifests.find((manifest) => manifest.id === `core/${name}`);
}
