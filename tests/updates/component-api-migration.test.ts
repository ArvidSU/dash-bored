import * as projectLoader from "../../src/core/project";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { APP_VERSION } from "../../src/shared/app-metadata";
import type { ReleaseMetadata, UpdateReceipt } from "../../src/shared/updates";
import { inspectMigration } from "../../src/updates/migrations";
import { UpdateCoordinator } from "../../src/updates/coordinator";
import { atomicJson } from "../../src/core/fs-atomic";
import { parseReleaseMetadata, RELEASE_ASSET_BASE } from "../../src/updates/releases";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target: ReleaseMetadata = {
  format: 1, product: "dash-bored", version: APP_VERSION, channel: "canary", platform: "macos", arch: "arm64",
  minimumContract: 4, dashboardContract: 4, recipes: [], componentApiVersions: ["2.0.0"], notes: "",
  archive: { file: "app.app.tar.zst", sha256: "a".repeat(64) }, dmg: { file: "app.dmg", sha256: "b".repeat(64) },
  updater: { file: "canary-macos-arm64-update.json", sha256: "c".repeat(64) },
};
async function fixture(version: string, external = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dash-api-migration-"))); cleanup.push(root);
  const bundle = join(root, ".dash-bored");
  const reference = external ? "./components/external/vendor/panel" : "./components/panel";
  const directory = join(bundle, reference);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "component.yaml");
  const setVersion = async (apiVersion: string) => writeFile(manifestPath, stringify({ schemaVersion: 3, apiVersion, id: "vendor/panel", name: "Panel", description: "Independent panel", entry: "./index.tsx", propsSchema: {} }));
  await setVersion(version);
  await writeFile(join(directory, "index.tsx"), "export default function Panel() { return null; }");
  const config = join(bundle, "dash-bored.yaml");
  await writeFile(config, stringify({ schemaVersion: 4, name: "Independent", root: { id: "panel", component: reference } }));
  await writeFile(join(bundle, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: external ? { vendor: { url: "https://example.com/vendor.git", commit: "a".repeat(40), path: "components/external/vendor" } } : {} }));
  return { root, config, directory, manifestPath, setVersion };
}

for (const external of [false, true]) test(`schema-current ${external ? "pinned external" : "local"} API1 component requires migration`, async () => {
  const f = await fixture("1.0.0", external);
  const result = await inspectMigration(f.config, target);
  expect(result.status).toBe("required");
  expect(result.steps).toEqual([]);
  expect(result.componentApi?.manifests).toEqual([{ path: f.manifestPath, version: "1.0.0" }]);
  expect(await Bun.file(f.manifestPath).text()).toContain("1.0.0");
  await f.setVersion("2.0.0");
  expect((await inspectMigration(f.config, target)).status).toBe("current");
});

test("target metadata and unused catalog components do not get confused with the running parser", async () => {
  const f = await fixture("2.0.0");
  const unused = join(dirname(f.directory), "unused"); await mkdir(unused);
  await writeFile(join(unused, "component.yaml"), (await Bun.file(f.manifestPath).text()).replace('"2.0.0"', '"1.0.0"').replace("2.0.0", "1.0.0"));
  expect((await inspectMigration(f.config, target)).status).toBe("current");
  expect((await inspectMigration(f.config, { ...target, componentApiVersions: ["3.0.0"] })).status).toBe("required");
  expect(() => parseReleaseMetadata({ ...target, componentApiVersions: ["invalid"] })).toThrow("component API");
  expect(() => parseReleaseMetadata({ ...target, componentApiVersions: [] })).toThrow("component API");
});

test("missing used package cannot be reported as current", async () => {
  const f = await fixture("1.0.0", true);
  await rm(join(f.root, ".dash-bored/components/external/vendor"), { recursive: true });
  expect((await inspectMigration(f.config, target)).status).toBe("required");
});

for (const repair of [true, false]) test(`selected API migration ${repair ? "validates its repair" : "cannot falsely finish"}`, async () => {
  const f = await fixture("1.0.0");
  const directory = join(f.root, "updates");
  const receipt: UpdateReceipt = { format: 1, id: "component-api", release: { metadata: target, url: `https://github.com/ArvidSU/dash-bored/releases/tag/v${APP_VERSION}`, assetBase: `${RELEASE_ASSET_BASE}v${APP_VERSION}/` }, selected: [f.config], choice: "update-and-migrate", cancelled: false, installation: "installed", migrations: { [f.config]: { status: "pending" } } };
  await atomicJson(join(directory, "receipt.json"), receipt);
  let calls = 0;
  const coordinator = new UpdateCoordinator({ directory, listDashboards: async () => [f.config], currentVersion: APP_VERSION, migrate: async () => { calls++; if (repair) await f.setVersion("2.0.0"); return { snapshot: "/saved", message: "Agent says finished" }; } });
  await coordinator.reconcile();
  expect(calls).toBe(1);
  expect((await coordinator.receipt())?.migrations[f.config]?.status).toBe(repair ? "finished" : "failed");
  expect((await coordinator.receipt())?.migrations[f.config]?.snapshot).toBe("/saved");
});

for (const valid of [true, false]) test(`current API2 dashboard ${valid ? "validates without an agent" : "cannot finish with invalid configuration"}`, async () => {
  const f = await fixture("2.0.0");
  if (!valid) await writeFile(f.config, "schemaVersion: 4\n");
  const directory = join(f.root, "updates");
  const pending: UpdateReceipt = { format: 1, id: "current-api", release: { metadata: target, url: `https://github.com/ArvidSU/dash-bored/releases/tag/v${APP_VERSION}`, assetBase: `${RELEASE_ASSET_BASE}v${APP_VERSION}/` }, selected: [f.config], choice: "update-and-migrate", cancelled: false, installation: "installed", migrations: { [f.config]: { status: "pending" } } };
  await atomicJson(join(directory, "receipt.json"), pending);
  const coordinator = new UpdateCoordinator({ directory, listDashboards: async () => [f.config], currentVersion: APP_VERSION, migrate: async () => { throw new Error("A current dashboard must not launch an agent"); } });
  await coordinator.reconcile();
  expect((await coordinator.receipt())?.migrations[f.config]?.status).toBe(valid ? "finished" : "failed");
});


test("status polls reuse compatibility scans, while edits and durable checks refresh them", async () => {
  const f = await fixture("2.0.0");
  const loader = spyOn(projectLoader, "loadProjectDefinition");
  try {
    expect((await inspectMigration(f.config, target)).status).toBe("current");
    expect((await inspectMigration(f.config, target)).status).toBe("current");
    expect(loader).toHaveBeenCalledTimes(1);
    await f.setVersion("1.0.0");
    expect((await inspectMigration(f.config, target)).status).toBe("required");
    expect(loader).toHaveBeenCalledTimes(2);
    await inspectMigration(f.config, target, { fresh: true });
    expect(loader).toHaveBeenCalledTimes(3);
  } finally { loader.mockRestore(); }
});
