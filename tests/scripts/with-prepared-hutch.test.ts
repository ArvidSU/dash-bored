import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "../../scripts/with-prepared-hutch.sh");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runWithFiles(files: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "dash-bored-hutch-check-"));
  directories.push(cwd);
  for (const file of files) {
    const path = join(cwd, ".hutch/devkit", file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture");
  }
  const child = Bun.spawn({
    cmd: ["sh", script, "sh", "-c", 'printf "%s" "$1"; exit 7', "check", "argument with spaces"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("prepared Hutch command guard", () => {
  for (const files of [[], ["tsconfig.json"], ["api/config/electrobun-vite.ts"]]) {
    test(`blocks the child for incomplete preparation: ${files.join(", ") || "empty"}`, async () => {
      const result = await runWithFiles(files);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Missing .hutch/devkit/");
      expect(result.stderr).toContain("bun run worktree:setup");
    });
  }

  test("preserves arguments and child failure after successful preparation", async () => {
    const result = await runWithFiles(["tsconfig.json", "api/config/electrobun-vite.ts"]);
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("argument with spaces");
    expect(result.stderr).toBe("");
  });
});
