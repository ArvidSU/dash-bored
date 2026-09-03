import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import {
  addComponent,
  listComponents,
  loadProjectDefinition,
  removeComponent,
  statusComponents,
  syncComponents,
  updateComponent,
  TrustStore,
  parseDashboardLock,
  serializeDashboardLock,
} from "../../src/core";
import { parseComponentArguments } from "../../src/cli/component";
import type { DashboardConfig } from "../../src/shared/contracts";
import {
  createProject,
  defaultConfig,
  removeTemporaryDirectory,
  temporaryDirectory,
} from "./helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

function git(directory: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", ...args],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function initRepo(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "dash-bored-test@example.com");
  git(directory, "config", "user.name", "dash-bored-test");
  git(directory, "config", "commit.gpgsign", "false");
}

interface SourceFixture {
  directory: string;
  url: string;
  head: string;
}

async function makeSourceRepo(
  root: string,
  name: string,
  permissions: string[],
): Promise<SourceFixture> {
  const raw = join(root, name);
  await initRepo(raw);
  await writeFile(
    join(raw, "component.yaml"),
    stringify({
      schemaVersion: 2,
      id: name,
      name,
      description: `${name} component`,
      entry: "./index.tsx",
      propsSchema: { type: "object" },
      permissions,
    }),
    "utf8",
  );
  await writeFile(join(raw, "index.tsx"), "export default () => null;\n", "utf8");
  git(raw, "add", "-A");
  git(raw, "commit", "-m", "v1");
  const directory = await realpath(raw);
  return { directory, url: `file://${directory}`, head: git(raw, "rev-parse", "HEAD").trim() };
}

async function commitSourceVersion(
  source: SourceFixture,
  message: string,
  permissions: string[],
): Promise<string> {
  const name = basename(source.directory);
  await writeFile(
    join(source.directory, "component.yaml"),
    stringify({
      schemaVersion: 2,
      id: name,
      name,
      description: `${name} component`,
      entry: "./index.tsx",
      propsSchema: { type: "object" },
      permissions,
    }),
    "utf8",
  );
  await writeFile(join(source.directory, "index.tsx"), `export default () => "${message}";\n`, "utf8");
  git(source.directory, "add", "-A");
  git(source.directory, "commit", "-m", message);
  return git(source.directory, "rev-parse", "HEAD").trim();
}

function externalConfig(): DashboardConfig {
  return {
    schemaVersion: 2,
    name: "External parent",
    root: { component: "./components/external/widgets" },
  };
}

async function makeParentRepo(root: string, name: string, config: DashboardConfig = defaultConfig): Promise<string> {
  const directory = join(root, name);
  await createProject(directory, config);
  await initRepo(directory);
  git(directory, "add", "-A");
  git(directory, "commit", "-m", "init");
  return directory;
}

describe("external component submodule operations", () => {
  test("add pins the exact remote SHA and the lock round-trips", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent");

    const added = await addComponent(parent, source.url, { name: "widgets" });
    expect(added).toEqual({ name: "widgets", commit: source.head });

    const lockPath = join(parent, ".dash-bored", "dash-bored-lock.yaml");
    const parsed = await parseDashboardLock(lockPath);
    expect(parsed.value?.components["widgets"]).toEqual({
      url: source.url,
      commit: source.head,
      path: "components/external/widgets",
    });

    const reserialized = serializeDashboardLock(parsed.value!);
    const roundTripPath = join(parent, ".dash-bored", "dash-bored-lock.roundtrip.yaml");
    await writeFile(roundTripPath, reserialized, "utf8");
    const reparsed = await parseDashboardLock(roundTripPath);
    expect(reparsed.value).toEqual(parsed.value);
    expect(serializeDashboardLock(reparsed.value!)).toBe(reserialized);

    const listed = await listComponents(parent);
    expect(listed).toEqual([{
      name: "widgets",
      url: source.url,
      commit: source.head,
      path: "components/external/widgets",
    }]);

    const [status] = await statusComponents(parent, "widgets");
    expect(status).toMatchObject({
      name: "widgets",
      initialized: true,
      checkedOutCommit: source.head,
      dirty: false,
      inSync: true,
      updateAvailable: false,
    });
  });

  test("add derives the name from the URL and validates explicit names", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "gadget", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent");

    const added = await addComponent(parent, source.url);
    expect(added.name).toBe("gadget");

    await expect(addComponent(parent, source.url, { name: "gadget" })).rejects.toThrow(
      /already pinned/,
    );
    await expect(addComponent(parent, source.url, { name: "9bad" })).rejects.toThrow(
      /Invalid external component name/,
    );
  });

  test("status reports uninitialized and dirty checkouts", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent");
    await addComponent(parent, source.url, { name: "widgets" });
    const submodule = join(".dash-bored", "components", "external", "widgets");

    git(parent, "submodule", "deinit", "-f", "--", submodule);
    const uninitialized = await statusComponents(parent, "widgets");
    expect(uninitialized[0]).toMatchObject({ initialized: false, checkedOutCommit: null });
    // The pin is still known and the remote reachable: no phantom update.
    expect(uninitialized[0]?.updateAvailable).toBe(false);

    git(parent, "submodule", "update", "--init", "--", submodule);
    await writeFile(
      join(parent, submodule, "index.tsx"),
      "export default () => \"dirty\";\n",
      "utf8",
    );
    const [dirty] = await statusComponents(parent, "widgets");
    expect(dirty).toMatchObject({ initialized: true, dirty: true, inSync: true });
  });

  test("status reports unknown when the remote is unreachable", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const parent = await makeParentRepo(root, "parent");
    await writeFile(
      join(parent, ".dash-bored", "dash-bored-lock.yaml"),
      stringify({
        lockfileVersion: 1,
        components: {
          ghost: {
            url: "file:///nonexistent-remote.git",
            commit: "0123456789abcdef0123456789abcdef01234567",
            path: "components/external/ghost",
          },
        },
      }),
      "utf8",
    );

    const [status] = await statusComponents(parent, "ghost");
    expect(status).toMatchObject({ initialized: false, updateAvailable: null });
  });

  test("update moves the pin and refuses dirty checkouts", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent", externalConfig());
    await addComponent(parent, source.url, { name: "widgets" });
    const submodule = join(parent, ".dash-bored", "components", "external", "widgets");

    const second = await commitSourceVersion(source, "v2", ["filesystem:read", "network:http"]);
    const drifted = await statusComponents(parent, "widgets");
    expect(drifted[0]?.updateAvailable).toBe(true);

    const updated = await updateComponent(parent, "widgets", {});
    expect(updated).toEqual({ name: "widgets", commit: second, changed: true });
    const parsed = await parseDashboardLock(join(parent, ".dash-bored", "dash-bored-lock.yaml"));
    expect(parsed.value?.components["widgets"]?.commit).toBe(second);

    const repeated = await updateComponent(parent, "widgets", {});
    expect(repeated.changed).toBe(false);

    await writeFile(join(submodule, "index.tsx"), "export default () => \"dirty\";\n", "utf8");
    await expect(updateComponent(parent, "widgets", {})).rejects.toThrow(/local changes/);
    const afterFailed = await parseDashboardLock(join(parent, ".dash-bored", "dash-bored-lock.yaml"));
    expect(afterFailed.value?.components["widgets"]?.commit).toBe(second);
  });

  test("a pin update declaring new permissions invalidates trust", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent", externalConfig());
    await addComponent(parent, source.url, { name: "widgets" });

    const store = new TrustStore(join(root, "state", "trust.json"));
    const before = await loadProjectDefinition(parent);
    expect(before.ok).toBe(true);
    expect(before.permissions).toEqual(["filesystem:read"]);
    await store.trust(parent, before.permissions);
    expect(await store.isTrusted(parent, before.permissions)).toBe(true);

    await commitSourceVersion(source, "v2", ["filesystem:read", "network:http"]);
    await updateComponent(parent, "widgets", {});

    const after = await loadProjectDefinition(parent);
    expect(after.ok).toBe(true);
    expect(after.permissions).toEqual(["filesystem:read", "network:http"]);
    expect(await store.isTrusted(parent, after.permissions)).toBe(false);
  });

  test("remove detaches the submodule and cleans the lock entry", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent");
    await addComponent(parent, source.url, { name: "widgets" });

    const removed = await removeComponent(parent, "widgets");
    expect(removed).toEqual({ name: "widgets" });

    const parsed = await parseDashboardLock(join(parent, ".dash-bored", "dash-bored-lock.yaml"));
    expect(parsed.value?.components).toEqual({});
    expect(await listComponents(parent)).toEqual([]);
    const gitmodules = await readFile(join(parent, ".gitmodules"), "utf8").catch(() => "");
    expect(gitmodules).not.toContain("widgets");

    await expect(removeComponent(parent, "widgets")).rejects.toThrow(/Unknown external component/);

    // Removing must not leave residue that blocks re-adding the same name.
    const readded = await addComponent(parent, source.url, { name: "widgets" });
    expect(readded.commit).toBe(source.head);
  });

  test("sync initializes missing checkouts to the pinned commit", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const source = await makeSourceRepo(root, "widgets", ["filesystem:read"]);
    const parent = await makeParentRepo(root, "parent");
    await addComponent(parent, source.url, { name: "widgets" });
    const submodule = join(".dash-bored", "components", "external", "widgets");

    git(parent, "submodule", "deinit", "-f", "--", submodule);
    const synced = await syncComponents(parent);
    expect(synced).toEqual([{
      name: "widgets",
      url: source.url,
      commit: source.head,
      path: "components/external/widgets",
    }]);
    const [status] = await statusComponents(parent, "widgets");
    expect(status).toMatchObject({ initialized: true, checkedOutCommit: source.head, inSync: true });

    const second = await commitSourceVersion(source, "v2", ["filesystem:read"]);
    await updateComponent(parent, "widgets", {});
    git(join(parent, submodule), "checkout", source.head);
    const drifted = await statusComponents(parent, "widgets");
    expect(drifted[0]?.inSync).toBe(false);
    await syncComponents(parent);
    const restored = await statusComponents(parent, "widgets");
    expect(second).not.toBe(source.head);
    expect(restored[0]).toMatchObject({ initialized: true, checkedOutCommit: second, inSync: true });
  });

  test("operations reject projects outside a git checkout and unknown names", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const plain = join(root, "plain");
    await createProject(plain);
    await expect(addComponent(plain, "file:///example.git")).rejects.toThrow(/git/);

    const parent = await makeParentRepo(root, "parent");
    await expect(updateComponent(parent, "missing", {})).rejects.toThrow(/Unknown external component/);
    await expect(statusComponents(parent, "missing")).rejects.toThrow(/Unknown external component/);
    await expect(syncComponents(parent)).resolves.toEqual([]);
  });

  test("discovers components nested below the submodule root", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const raw = join(root, "monorepo");
    await initRepo(raw);
    await mkdir(join(raw, "packs", "mywidget"), { recursive: true });
    await writeFile(
      join(raw, "packs", "mywidget", "component.yaml"),
      stringify({
        schemaVersion: 2,
        id: "mywidget",
        name: "mywidget",
        description: "nested component",
        entry: "./index.tsx",
        propsSchema: { type: "object" },
        permissions: [],
      }),
      "utf8",
    );
    await writeFile(join(raw, "packs", "mywidget", "index.tsx"), "export default () => null;\n", "utf8");
    git(raw, "add", "-A");
    git(raw, "commit", "-m", "v1");
    const head = git(raw, "rev-parse", "HEAD").trim();
    const parent = await makeParentRepo(root, "parent");
    const added = await addComponent(parent, `file://${await realpath(raw)}`, { name: "toolkit" });
    expect(added.commit).toBe(head);

    const definition = await loadProjectDefinition(parent);
    const nested = definition.componentCatalog.find(
      (item) => item.reference === "./components/external/toolkit/packs/mywidget",
    );
    expect(nested).toMatchObject({ source: "external", available: true });
    expect(nested?.manifest?.id).toBe("mywidget");
  });

  test("reports empty external checkouts as uninitialized", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const parent = await makeParentRepo(root, "parent");
    await mkdir(join(parent, ".dash-bored", "components", "external", "ghost"), { recursive: true });

    const definition = await loadProjectDefinition(parent);
    const ghost = definition.componentCatalog.find(
      (item) => item.reference === "./components/external/ghost",
    );
    expect(ghost).toMatchObject({ source: "external", available: false });
    expect(ghost?.diagnostics.some((item) => item.code === "COMPONENT_EXTERNAL_UNINITIALIZED")).toBe(true);
  });

  test("reports checked-out externals without manifests distinctly", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const parent = await makeParentRepo(root, "parent");
    const hollow = join(parent, ".dash-bored", "components", "external", "hollow");
    await mkdir(hollow, { recursive: true });
    await writeFile(join(hollow, "README.md"), "# not a component\n", "utf8");

    const definition = await loadProjectDefinition(parent);
    const item = definition.componentCatalog.find(
      (entry) => entry.reference === "./components/external/hollow",
    );
    expect(item).toMatchObject({ source: "external", available: false });
    expect(item?.diagnostics.some((entry) => entry.code === "COMPONENT_EXTERNAL_NO_MANIFEST")).toBe(true);
    expect(item?.diagnostics.some((entry) => entry.code === "COMPONENT_EXTERNAL_UNINITIALIZED")).toBe(false);
  });
});

describe("component CLI argument parsing", () => {
  test("parses each subcommand and rejects misuse", () => {
    expect(parseComponentArguments([])).toMatchObject({ help: true, error: null });
    expect(parseComponentArguments(["add"])).toMatchObject({
      error: expect.stringContaining("requires a repository URL"),
    });
    expect(parseComponentArguments(["bogus"])).toMatchObject({
      error: expect.stringContaining("Unknown component command"),
    });
    expect(parseComponentArguments(["add", "https://example.com/x.git", "--name", "x", "--ref", "main"]))
      .toMatchObject({ subcommand: "add", url: "https://example.com/x.git", name: "x", ref: "main", project: "." });
    expect(parseComponentArguments(["add", "https://example.com/x.git", "proj"])).toMatchObject({
      subcommand: "add",
      project: "proj",
    });
    expect(parseComponentArguments(["list"])).toMatchObject({ subcommand: "list", project: "." });
    expect(parseComponentArguments(["status"])).toMatchObject({
      subcommand: "status",
      name: null,
      project: ".",
    });
    expect(parseComponentArguments(["status", "widgets"])).toMatchObject({
      subcommand: "status",
      name: "widgets",
      project: ".",
    });
    expect(parseComponentArguments(["status", "./proj"])).toMatchObject({
      subcommand: "status",
      name: null,
      project: "./proj",
    });
    expect(parseComponentArguments(["status", "widgets", "./proj"])).toMatchObject({
      subcommand: "status",
      name: "widgets",
      project: "./proj",
    });
    expect(parseComponentArguments(["update"])).toMatchObject({
      error: expect.stringContaining("requires a component name"),
    });
    expect(parseComponentArguments(["update", "widgets", "--to", "v2"])).toMatchObject({
      subcommand: "update",
      name: "widgets",
      to: "v2",
    });
    expect(parseComponentArguments(["list", "--to", "x"])).toMatchObject({
      error: expect.stringContaining("does not accept --to"),
    });
    expect(parseComponentArguments(["remove", "widgets", "--name", "x"])).toMatchObject({
      error: expect.stringContaining("does not accept --name"),
    });
  });
});
