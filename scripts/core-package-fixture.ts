/** Read the pinned package for docs/tests; never a production component registry. */
import { CORE_PACKAGE } from "../src/shared/core-package";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { ComponentManifest } from "../src/shared/contracts";
export const coreFixtureRoot = resolve(import.meta.dirname, "../.dash-bored/components/external/core");
export const coreManifests: ComponentManifest[] = [];
export function coreReference(name: string): string { return `./components/external/core/${name.replace(/^core\//, "")}`; }
const checkedOut = execFileSync("git", ["-C", coreFixtureRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (checkedOut !== CORE_PACKAGE.commit) throw new Error("Restore the release-pinned core package before generating references or fixtures.");
for (const entry of readdirSync(coreFixtureRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory()) continue;
  const path = resolve(coreFixtureRoot, entry.name, "component.yaml");
  if (existsSync(path)) coreManifests.push(parse(readFileSync(path, "utf8")) as ComponentManifest);
}
export function getCoreManifest(reference: string): ComponentManifest | undefined {
  const name = reference.slice(reference.lastIndexOf("/") + 1);
  return coreManifests.find((manifest) => manifest.id === `core/${name}`);
}
