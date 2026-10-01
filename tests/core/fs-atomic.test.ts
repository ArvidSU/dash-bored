import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomically } from "../../src/core/fs-atomic";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dash-bored-atomic-"));
  directories.push(directory);
  return directory;
}

test("atomic replacement preserves requested private mode and cleans failed writes", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "settings.json");

  await writeFileAtomically(path, "original", { mode: 0o600 });
  await writeFileAtomically(path, "replacement", { mode: 0o600 });
  expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await stat(path)).mode & 0o777).toBe(0o600);

  await expect(writeFileAtomically(path, "rejected", {
    mode: 0o600,
    beforePublish: () => { throw new Error("guard rejected write"); },
  })).rejects.toThrow("guard rejected write");

  expect(await readFile(path, "utf8")).toBe("replacement");
  expect(await readdir(directory)).toEqual(["settings.json"]);
});

test("exclusive publication never replaces an existing file and removes its temporary file", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "starter.yaml");
  await writeFileAtomically(path, "project-owned", { mode: 0o644, sync: true, exclusive: true });

  await expect(writeFileAtomically(path, "replacement", {
    mode: 0o644,
    sync: true,
    exclusive: true,
  })).rejects.toMatchObject({ code: "EEXIST" });

  expect(await readFile(path, "utf8")).toBe("project-owned");
  expect(await readdir(directory)).toEqual(["starter.yaml"]);
});
