import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

export interface InstallCliOptions {
  sourcePath?: string;
  targetDirectory?: string;
  platform?: NodeJS.Platform;
  pathValue?: string;
}

export interface InstallCliResult {
  sourcePath: string;
  targetPath: string;
  created: boolean;
  targetDirectoryOnPath: boolean;
}

async function bundledCliSource(explicit?: string): Promise<string> {
  const configured = explicit ?? process.env.DASH_BORED_BUNDLED_CLI;
  if (configured) return realpath(resolve(configured));

  const executable = await realpath(process.execPath);
  const main = await realpath(Bun.main).catch(() => null);
  if (main === executable || basename(executable).startsWith("dash-bored")) {
    return executable;
  }

  throw new Error(
    "install-cli must be run from the dash-bored app's bundled CLI or an already installed standalone CLI.",
  );
}

async function ensureTargetDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`CLI target directory must not be a symbolic link: ${path}`);
    if (!info.isDirectory()) throw new Error(`CLI target is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
  }
}

export async function installDashBoredCli(
  options: InstallCliOptions = {},
): Promise<InstallCliResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("install-cli currently supports macOS and Linux; the Windows app still contains its bundled CLI.");
  }

  const sourcePath = await bundledCliSource(options.sourcePath);
  await access(sourcePath, constants.X_OK);
  const targetDirectory = resolve(options.targetDirectory ?? join(homedir(), ".local", "bin"));
  await ensureTargetDirectory(targetDirectory);
  const targetPath = join(targetDirectory, "dash-bored");

  let created = false;
  try {
    const info = await lstat(targetPath);
    if (!info.isSymbolicLink()) {
      throw new Error(`Refusing to replace an existing CLI file: ${targetPath}`);
    }
    const linkTarget = resolve(targetDirectory, await readlink(targetPath));
    if (await realpath(linkTarget).catch(() => null) !== sourcePath) {
      throw new Error(`Refusing to replace an existing CLI link: ${targetPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(sourcePath, targetPath, "file");
    created = true;
  }

  const pathEntries = (options.pathValue ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return {
    sourcePath,
    targetPath,
    created,
    targetDirectoryOnPath: pathEntries.includes(targetDirectory),
  };
}
