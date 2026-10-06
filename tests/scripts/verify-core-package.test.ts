import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { verifyCorePackagePublished } from "../../scripts/verify-core-package";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(apiVersion = "1.0.0") {
  const root = await mkdtemp(join(tmpdir(), "dash-bored-published-core-test-")); cleanup.push(root);
  const source = join(root, "source"), remote = join(root, "remote.git");
  await mkdir(join(source, "group"), { recursive: true });
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Test"); git(source, "config", "user.email", "test@example.com"); git(source, "config", "commit.gpgsign", "false");
  await writeFile(join(source, "group", "component.yaml"), stringify({ schemaVersion: 3, apiVersion, id: "core/group", name: "Group", description: "Test", entry: "./index.js", types: "./index.d.ts", propsSchema: { type: "object" } }));
  await writeFile(join(source, "group", "index.js"), "export default function Group() { return null; }\n");
  await writeFile(join(source, "group", "index.d.ts"), "export default function Group(): null;\n");
  git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Published component");
  const commit = git(source, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", source, remote);
  return { source, pin: { url: pathToFileURL(remote).href, commit } };
}

test("a fresh checkout validates a published core pin without installed SDK files", async () => {
  const { pin } = await fixture();
  await verifyCorePackagePublished(pin);
}, 30_000);

test("a commit present only in the author's checkout fails publication verification", async () => {
  const { source, pin } = await fixture();
  await writeFile(join(source, "local.txt"), "Unpublished\n");
  git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Unpublished change");
  await expect(verifyCorePackagePublished({ ...pin, commit: git(source, "rev-parse", "HEAD") })).rejects.toThrow("Publish the core commit before distributing this app");
}, 30_000);

test("a published package targeting an unsupported API fails verification", async () => {
  const { pin } = await fixture("99.0.0");
  await expect(verifyCorePackagePublished(pin)).rejects.toThrow("COMPONENT_API_UNSUPPORTED");
}, 30_000);
