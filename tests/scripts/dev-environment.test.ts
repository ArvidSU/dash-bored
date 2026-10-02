import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { devInstance, ensureDevEnvironment } from "../../scripts/dev-environment";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("checkouts have independent toolchain state and stable identities, without inheriting shared locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dash-bored-dev-env-"));
  directories.push(directory);
  const shared = join(directory, "shared");
  await mkdir(join(shared, "releases"), { recursive: true });
  await writeFile(join(shared, "releases", "tool"), "original");
  await writeFile(join(shared, "releases", "busy.lock"), "locked");
  const first = join(directory, "first");
  const second = join(directory, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const a = await ensureDevEnvironment(first, shared);
  const b = await ensureDevEnvironment(second, shared);
  expect(devInstance(a)).not.toBe(devInstance(b));
  expect(a.DASH_BORED_VITE_PORT).not.toBe(b.DASH_BORED_VITE_PORT);
  expect(a.HUTCH_HOME).not.toBe(b.HUTCH_HOME);
  await writeFile(join(a.HUTCH_HOME!, "releases", "tool"), "changed");
  expect(await readFile(join(shared, "releases", "tool"), "utf8")).toBe("original");
  expect(await readFile(join(b.HUTCH_HOME!, "releases", "tool"), "utf8")).toBe("original");
  expect(await Bun.file(join(a.HUTCH_HOME!, "releases", "busy.lock")).exists()).toBeFalse();
  expect(await ensureDevEnvironment(first, shared)).toEqual(a);
});

test("checkout wrapper targets its dev instance, and release builds clear development overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-bored-dev-wrapper-"));
  directories.push(root);
  await writeFile(join(root, ".env.worktree"), 'DASH_BORED_INSTANCE="wt-fixture"\nHUTCH_HOME="/fixture/hutch"\n');
  const wrapper = resolve(import.meta.dirname, "../../scripts/with-worktree-env.sh");
  const run = async (release: boolean) => {
    const child = Bun.spawn(["sh", wrapper, "sh", "-c", 'printf "%s|%s" "$DASH_BORED_APP_INSTANCE" "$HUTCH_HOME"'], {
      cwd: root, env: { ...process.env, DASH_BORED_APP_INSTANCE: "parent-instance", HUTCH_HOME: "/parent", DASH_BORED_RELEASE: release ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return output;
  };
  expect(await run(false)).toBe("dev.dash-bored.wt-fixture.dev|/fixture/hutch");
  expect(await run(true)).toBe("|");
});
