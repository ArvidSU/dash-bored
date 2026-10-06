import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkComponentDirectory } from "../src/core/component-authoring";
import { CORE_PACKAGE } from "../src/shared/core-package";

/** Verify the published pin without reusing the developer's managed checkout. */
export async function verifyCorePackagePublished(pin: { url: string; commit: string } = CORE_PACKAGE): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "dash-bored-core-publication-"));
  const checkout = join(scratch, "core");
  // Local test URL rewrites must never make an unpublished release pin pass.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_") && !["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key)));
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  async function git(args: string[]): Promise<void> {
    const child = Bun.spawn(["git", "-c", "protocol.file.allow=always", ...args], { cwd: scratch, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Default core package ${pin.commit} cannot be restored from ${pin.url}. Publish the core commit before distributing this app. ${(error || output).trim()}`);
  }
  try {
    await git(["init", "--quiet", checkout]);
    await git(["-C", checkout, "fetch", "--quiet", "--depth=1", pin.url, pin.commit]);
    await git(["-C", checkout, "checkout", "--quiet", "--detach", pin.commit]);
    let count = 0;
    for (const entry of await readdir(checkout, { withFileTypes: true })) {
      if (!entry.isDirectory() || !await Bun.file(join(checkout, entry.name, "component.yaml")).exists()) continue;
      const result = await checkComponentDirectory(join(checkout, entry.name));
      if (!result.ok) throw new Error(`Published core component ${entry.name} is incompatible with this app: ${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
      count++;
    }
    if (!count || !await Bun.file(join(checkout, "group", "component.yaml")).exists()) throw new Error("The published core package is missing the starter's group component.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verifyCorePackagePublished();
  console.log(`Verified published core package ${CORE_PACKAGE.commit}.`);
}
