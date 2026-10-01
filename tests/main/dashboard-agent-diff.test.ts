import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_AGENT_DIFF_BYTES, readDashboardAgentDiff } from "../../src/main/dashboard-agent-diff";
import { removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

async function git(root: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}

async function repository(): Promise<{ root: string; folder: string }> {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const folder = join(root, ".dash-bored");
  await mkdir(folder);
  await writeFile(join(folder, "dash-bored.yaml"), "name: Before\n");
  await writeFile(join(root, ".gitignore"), ".dash-bored/ignored.txt\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Diff test", "-c", "user.email=diff@example.invalid", "commit", "-qm", "Baseline");
  return { root, folder };
}

describe("dashboard agent diff", () => {
  test("includes staged, unstaged, and new nested files without changing the index", async () => {
    const { root, folder } = await repository();
    await writeFile(join(folder, "dash-bored.yaml"), "name: After\n");
    await writeFile(join(folder, "staged.txt"), "staged content\n");
    await git(root, "add", ".dash-bored/staged.txt");
    await mkdir(join(folder, "scripts"));
    await writeFile(join(folder, "scripts", "health check.py"), 'print("healthy")\n');
    await writeFile(join(folder, "line\nbreak.txt"), "newline filename\n");
    await writeFile(join(folder, "empty.txt"), "");
    await writeFile(join(folder, "ignored.txt"), "ignored secret\n");
    await writeFile(join(root, "unrelated.txt"), "outside secret\n");
    const status = await git(root, "status", "--porcelain=v1", "-z");

    const diff = await readDashboardAgentDiff(root, folder);

    expect(diff).toContain("+name: After");
    expect(diff).toContain("+staged content");
    expect(diff).toContain(".dash-bored/scripts/health check.py");
    expect(diff).toContain('+print("healthy")');
    expect(diff).toContain("+newline filename");
    expect(diff).toContain(".dash-bored/empty.txt");
    expect(diff).not.toContain("ignored secret");
    expect(diff).not.toContain("outside secret");
    expect(await git(root, "status", "--porcelain=v1", "-z")).toBe(status);
  });

  test("shows symlink targets and binary summaries without reading through links", async () => {
    const { root, folder } = await repository();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "private target contents\n");
    await symlink(outside, join(folder, "link.txt"));
    await writeFile(join(folder, "image.bin"), new Uint8Array([0, 1, 2, 3]));

    const diff = await readDashboardAgentDiff(root, folder);

    expect(diff).toContain("new file mode 120000");
    expect(diff).toContain(`+${outside}`);
    expect(diff).not.toContain("private target contents");
    expect(diff).toContain("Binary files /dev/null and b/.dash-bored/image.bin differ");
  });

  test("scopes new files to the owning named bundle", async () => {
    const { root, folder } = await repository();
    const named = join(folder, "named");
    await mkdir(named);
    await writeFile(join(named, "new.txt"), "owned change\n");
    await writeFile(join(folder, "sibling.txt"), "sibling change\n");

    const diff = await readDashboardAgentDiff(root, named);

    expect(diff).toContain("+owned change");
    expect(diff).not.toContain("sibling change");
    expect(diff).not.toContain("dash-bored.yaml");
  });

  test("rejects a combined diff over the limit even when individual patches fit", async () => {
    const { root, folder } = await repository();
    const content = "x".repeat(Math.ceil(MAX_AGENT_DIFF_BYTES / 2));
    await writeFile(join(folder, "dash-bored.yaml"), `${content}\n`);
    await writeFile(join(folder, "new.txt"), `${content}\n`);

    await expect(readDashboardAgentDiff(root, folder)).rejects.toMatchObject({ code: "DASHBOARD_AGENT_DIFF_TOO_LARGE" });
  });

  test("returns empty for a clean bundle and rejects paths outside the project", async () => {
    const { root, folder } = await repository();
    expect(await readDashboardAgentDiff(root, folder)).toBe("");
    await expect(readDashboardAgentDiff(root, join(root, "..", "outside"))).rejects.toMatchObject({ code: "DASHBOARD_AGENT_DIFF_PATH_INVALID" });
    await expect(readDashboardAgentDiff(root, root)).rejects.toMatchObject({ code: "DASHBOARD_AGENT_DIFF_PATH_INVALID" });
  });
});
