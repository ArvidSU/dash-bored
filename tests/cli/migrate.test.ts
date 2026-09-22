import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("migrate inspect reports the current contract and rejects other verbs", async () => {
  const project = await mkdtemp(join(tmpdir(), "dash-bored-migrate-"));
  try {
    expect((await run("init", "--project", project)).code).toBe(0);
    const inspected = await run("migrate", "inspect", project);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout).status).toBe("current");
    const other = await run("migrate", "--dashboard", project);
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain("dash-bored migrate inspect <dashboard>");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
