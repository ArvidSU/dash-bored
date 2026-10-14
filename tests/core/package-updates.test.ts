import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { addComponent } from "../../src/core";
import { checkPackageUpdates, packageChangesUrl, preferredTag } from "../../src/core/package-updates";
import { readRemoteHeadAndTags } from "../../src/core/package-store";
import { addTheme } from "../../src/core/theme-install";
import { createPackageUpdates } from "../../src/main/package-updates";
import type { ProjectSnapshot } from "../../src/shared/contracts";
import type { PackageUpdateState } from "../../src/shared/package-updates";
import { packageVersionLabel } from "../../src/shared/package-updates";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory)); });

async function temp(): Promise<string> {
  const directory = await temporaryDirectory();
  cleanup.push(directory);
  return realpath(directory);
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function sourceRepo(directory: string, file: string, content: string): Promise<{ url: string; commit: (content: string, tag?: string) => Promise<string> }> {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "dash-bored-test@example.com");
  git(directory, "config", "user.name", "dash-bored-test");
  git(directory, "config", "commit.gpgsign", "false");
  const commit = async (next: string, tag?: string) => {
    await writeFile(join(directory, file), next, "utf8");
    git(directory, "add", "-A");
    git(directory, "commit", "-m", tag ?? "change");
    if (tag) git(directory, "tag", "-a", tag, "-m", tag);
    return git(directory, "rev-parse", "HEAD");
  };
  await commit(content, "v1.0.0");
  return { url: `file://${directory}`, commit };
}

const componentManifest = (label: string) => stringify({
  schemaVersion: 3, apiVersion: "1.0.0", id: "widgets", name: "Widgets", description: label,
  entry: "./index.tsx", propsSchema: { type: "object" },
});
const themeManifest = (accent: string) => stringify({ schemaVersion: 1, id: "ocean", name: "Ocean", light: { accent }, dark: { accent } });

async function bundle(root: string): Promise<string> {
  await createProject(root, { schemaVersion: 4, name: "Packages", root: { component: "./components/external/widgets" } });
  return join(root, ".dash-bored", "dash-bored.yaml");
}

describe("package update checks", () => {
  test("reports pins behind the default branch with release tags, and local reasons an update would refuse", async () => {
    const root = await temp();
    const widgets = await sourceRepo(join(root, "widgets"), "component.yaml", componentManifest("one"));
    const ocean = await sourceRepo(join(root, "ocean"), "theme.yaml", themeManifest("#123456"));
    const configPath = await bundle(join(root, "project"));
    const personal = join(root, "personal");
    await addComponent(configPath, widgets.url, { name: "widgets" });
    await addTheme({ global: true, globalDirectory: personal }, ocean.url, { name: "ocean" });
    const sources = [{ configPath, dashboardName: "Packages" }, { configPath: null }];

    const fresh = await checkPackageUpdates(sources, { personalDirectory: personal });
    expect(fresh.problems).toEqual([]);
    expect(fresh.packages.map((item) => [item.id, item.status, packageVersionLabel(item.current)])).toEqual([
      [`component:${configPath}:widgets`, "current", "v1.0.0"],
      ["theme:personal:ocean", "current", "v1.0.0"],
    ]);

    await widgets.commit(componentManifest("two"));
    const tagged = await widgets.commit(componentManifest("three"), "v1.1.0");
    await ocean.commit(themeManifest("#654321"));
    const behind = await checkPackageUpdates(sources, { personalDirectory: personal });
    const [component, theme] = behind.packages;
    expect(component).toMatchObject({
      status: "available", dashboardName: "Packages", current: { tag: "v1.0.0" }, latest: { commit: tagged, tag: "v1.1.0" },
    });
    expect(component!.blocked).toBeUndefined();
    // file:// remotes have no hosted compare page.
    expect(component!.changesUrl).toBeUndefined();
    expect(theme).toMatchObject({ status: "available", configPath: null, current: { tag: "v1.0.0" } });
    expect(packageVersionLabel(theme!.latest!)).toBe(theme!.latest!.commit.slice(0, 7));

    await writeFile(join(root, "project", ".dash-bored", "components", "external", "widgets", "scratch.txt"), "unsaved");
    const dirty = await checkPackageUpdates(sources, { personalDirectory: personal });
    expect(dirty.packages[0]!.blocked).toContain("local changes");
  }, 60_000);

  test("one unreachable repository or unreadable lock does not hide the other packages", async () => {
    const root = await temp();
    const widgets = await sourceRepo(join(root, "widgets"), "component.yaml", componentManifest("one"));
    const configPath = await bundle(join(root, "project"));
    await addComponent(configPath, widgets.url, { name: "widgets" });
    const broken = await bundle(join(root, "broken"));
    await writeFile(join(root, "broken", ".dash-bored", "dash-bored-lock.yaml"), "lockfileVersion: 9\n");
    const reads: string[] = [];
    const moved = join(root, "moved", ".dash-bored", "dash-bored.yaml");
    const result = await checkPackageUpdates([{ configPath }, { configPath: broken, dashboardName: "Broken" }, { configPath: moved }], {
      personalDirectory: join(root, "personal"),
      readRemote: async (url) => { reads.push(url); throw new Error(`offline: ${url}`); },
    });
    expect(reads).toEqual([widgets.url]);
    expect(result.packages[0]).toMatchObject({ status: "unknown", latest: null, error: `offline: ${widgets.url}` });
    expect(result.problems).toEqual([expect.stringContaining("Could not read the packages of Broken")]);
  }, 60_000);

  test("missing checkouts are reported without touching the network twice for one repository", async () => {
    const root = await temp();
    const widgets = await sourceRepo(join(root, "widgets"), "component.yaml", componentManifest("one"));
    const first = await bundle(join(root, "first"));
    const second = await bundle(join(root, "second"));
    await addComponent(first, widgets.url, { name: "widgets" });
    await writeFile(join(root, "second", ".dash-bored", "dash-bored-lock.yaml"), stringify({
      lockfileVersion: 1,
      components: { widgets: { url: widgets.url, commit: git(join(root, "widgets"), "rev-parse", "HEAD"), path: "components/external/widgets" } },
    }));
    let reads = 0;
    const result = await checkPackageUpdates([{ configPath: first }, { configPath: second }], {
      personalDirectory: join(root, "personal"),
      readRemote: (url) => { reads++; return readRemoteHeadAndTags(url); },
    });
    expect(reads).toBe(1);
    expect(result.packages.map((item) => item.status)).toEqual(["current", "current"]);
    expect(result.packages[1]!.blocked).toContain("Not checked out");
  }, 60_000);

  test("remote URLs never become git options", async () => {
    const root = await temp();
    const marker = join(root, "ran");
    await expect(readRemoteHeadAndTags(`--upload-pack=touch ${marker}`)).rejects.toThrow("Could not reach");
    await expect(stat(marker)).rejects.toThrow();
  });

  test("labels prefer semver tags and compare pages exist only for known hosts", () => {
    expect(preferredTag(["latest", "v1.2.0", "v1.10.0", "v1.9.9"])).toBe("v1.10.0");
    expect(preferredTag(["beta", "alpha"])).toBe("beta");
    expect(preferredTag(undefined)).toBeUndefined();
    expect(packageVersionLabel({ commit: "a".repeat(40), base: { tag: "v0.1.4", ahead: 4 } })).toBe("v0.1.4+4");
    const [from, to] = ["a".repeat(40), "b".repeat(40)];
    expect(packageChangesUrl("https://github.com/ArvidSU/dash-bored-components.git", from, to))
      .toBe(`https://github.com/ArvidSU/dash-bored-components/compare/${from}...${to}`);
    expect(packageChangesUrl("git@gitlab.com:group/sub/repo.git", from, to)).toBe(`https://gitlab.com/group/sub/repo/-/compare/${from}...${to}`);
    expect(packageChangesUrl("https://github.com/owner/../repo", from, to)).toBeUndefined();
    expect(packageChangesUrl("https://example.com/owner/repo.git", from, to)).toBeUndefined();
    expect(packageChangesUrl("file:///tmp/repo", from, to)).toBeUndefined();
  });
});

describe("package update service", () => {
  function snapshot(configPath: string | null, trusted = true): ProjectSnapshot {
    return { configPath, dashboardName: "Packages", trusted } as unknown as ProjectSnapshot;
  }

  test("checks in the background, updates explicitly, and re-runs trust for the open dashboard", async () => {
    const root = await temp();
    const widgets = await sourceRepo(join(root, "widgets"), "component.yaml", componentManifest("one"));
    const configPath = await bundle(join(root, "project"));
    await addComponent(configPath, widgets.url, { name: "widgets" });
    const pushes: PackageUpdateState[] = [];
    let active = snapshot(configPath);
    let reloads = 0;
    let themePublishes = 0;
    const service = createPackageUpdates({
      registry: { list: async () => [{ projectRoot: join(root, "project"), configPath, dashboardName: "Packages" }] },
      runtime: { getSnapshot: () => active, reload: async () => { reloads++; active = snapshot(configPath, false); } },
      publishThemes: async () => { themePublishes++; },
      onChange: (state) => pushes.push(state),
      automaticChecks: async () => true,
      personalDirectory: join(root, "personal"),
    });

    await expect(service.command({ type: "update", ids: [`component:${configPath}:widgets`] })).rejects.toThrow("Check for package updates");
    const latest = await widgets.commit(componentManifest("two"), "v2.0.0");
    await service.command({ type: "check" });
    await expect(service.command({ type: "check" })).rejects.toThrow("already running");
    await service.idle();
    expect(pushes[0]!.phase).toBe("checking");
    expect(service.state()).toMatchObject({ phase: "idle", packages: [{ status: "available", latest: { commit: latest } }] });
    expect(service.state().checkedAt).not.toBeNull();

    await service.command({ type: "update", ids: service.state().packages.map((item) => item.id) });
    expect(service.state()).toMatchObject({ phase: "updating", updating: [`component:${configPath}:widgets`] });
    await service.idle();
    expect(service.state()).toMatchObject({
      phase: "idle", updating: [], problem: "",
      packages: [{ status: "current", current: { commit: latest, tag: "v2.0.0" } }],
    });
    expect(service.state().message).toContain("Updated widgets to v2.0.0.");
    expect(service.state().message).toContain("asks for trust again");
    expect(reloads).toBe(1);
    expect(themePublishes).toBe(0);
    expect(git(join(root, "project", ".dash-bored", "components", "external", "widgets"), "rev-parse", "HEAD")).toBe(latest);
  }, 60_000);

  test("a failed update stays with its package and leaves the pin", async () => {
    const root = await temp();
    const widgets = await sourceRepo(join(root, "widgets"), "component.yaml", componentManifest("one"));
    const configPath = await bundle(join(root, "project"));
    const pinned = (await addComponent(configPath, widgets.url, { name: "widgets" })).commit;
    await widgets.commit(componentManifest("two"));
    const service = createPackageUpdates({
      registry: { list: async () => [] },
      runtime: { getSnapshot: () => snapshot(configPath), reload: async () => undefined },
      publishThemes: async () => undefined,
      onChange: () => undefined,
      automaticChecks: async () => false,
      personalDirectory: join(root, "personal"),
      updateComponent: async () => { throw new Error("network down"); },
    });
    await service.command({ type: "check" });
    await service.idle();
    await service.command({ type: "update", ids: [service.state().packages[0]!.id] });
    await service.idle();
    expect(service.state()).toMatchObject({
      phase: "idle", message: "", problem: "Could not update widgets (Packages).",
      packages: [{ status: "available", current: { commit: pinned }, error: "network down" }],
    });
  }, 60_000);
});
