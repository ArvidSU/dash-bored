import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDashBoredCli } from "../../src/cli/install-cli";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installDashBoredCli", () => {
  test("creates an idempotent user-approved CLI link without replacing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dash-bored-install-cli-"));
    cleanup.push(root);
    const sourcePath = join(root, "app", "dash-bored");
    const targetDirectory = join(root, "bin");
    await mkdir(join(root, "app"));
    await Bun.write(sourcePath, "#!/bin/sh\n");
    await chmod(sourcePath, 0o755);

    const installed = await installDashBoredCli({
      sourcePath,
      targetDirectory,
      pathValue: targetDirectory,
    });
    expect(installed.created).toBeTrue();
    expect(installed.targetDirectoryOnPath).toBeTrue();
    expect((await lstat(installed.targetPath)).isSymbolicLink()).toBeTrue();
    expect(await readlink(installed.targetPath)).toBe(installed.sourcePath);

    const repeated = await installDashBoredCli({ sourcePath, targetDirectory });
    expect(repeated.created).toBeFalse();

    await rm(installed.targetPath);
    await writeFile(installed.targetPath, "keep me\n");
    await expect(installDashBoredCli({ sourcePath, targetDirectory })).rejects.toThrow(
      "Refusing to replace an existing CLI file",
    );
  });
});
