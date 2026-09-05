import { randomUUID } from "node:crypto";
import { APP_VERSION } from "../shared/app-metadata";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readlink,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

export interface InstallCliOptions {
  sourcePath?: string;
  check?: boolean;
  targetDirectory?: string;
  platform?: NodeJS.Platform;
  pathValue?: string;
}

export interface InstallCliResult {
  sourcePath: string;
  targetPath: string;
  created: boolean;
  updated: boolean;
  targetDirectoryOnPath: boolean;
}

async function bundledCliSource(explicit?: string): Promise<string> {
  if (explicit) return realpath(resolve(explicit));

  const executable = await realpath(process.execPath);
  const main = await realpath(Bun.main).catch(() => null);
  if (main === executable || basename(executable).startsWith("dash-bored")) {
    return executable;
  }

  throw new Error(
    "install-cli must be run from the dash-bored app's bundled CLI or an already installed standalone CLI.",
  );
}

async function ensureTargetDirectory(path: string, check = false): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`CLI target directory must not be a symbolic link: ${path}`);
    if (!info.isDirectory()) throw new Error(`CLI target is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (check) throw new Error(`Missing CLI target directory: ${path}`);
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
  await ensureTargetDirectory(targetDirectory, options.check);
  const targetPath = join(targetDirectory, "dash-bored");

  const receiptPath = join(targetDirectory, ".dash-bored-cli.json");
  let receiptText: string | null = null;
  let receipt: { sourcePath: string; version: string } | null = null;
  try {
    const info = await lstat(receiptPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`CLI receipt must be a regular file: ${receiptPath}`);
    receiptText = await readFile(receiptPath, "utf8");
    receipt = JSON.parse(receiptText);
    if (typeof receipt?.sourcePath !== "string" || typeof receipt?.version !== "string") throw new Error(`Invalid CLI receipt: ${receiptPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let created = false;
  let updated = false;
  let previousLink: string | null = null;
  try {
    const info = await lstat(targetPath);
    if (!info.isSymbolicLink()) throw new Error(`Refusing to replace an existing CLI file: ${targetPath}`);
    previousLink = await readlink(targetPath);
    const linkTarget = resolve(targetDirectory, previousLink);
    const matchesSource = await realpath(linkTarget).catch(() => null) === sourcePath;
    if (!matchesSource && linkTarget !== receipt?.sourcePath) {
      throw new Error(`Refusing to replace an existing CLI link: ${targetPath}. Move the conflicting link aside before reinstalling.`);
    }
    updated = !matchesSource || receipt?.version !== APP_VERSION || receipt?.sourcePath !== sourcePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  if (options.check) {
    if (created || updated) throw new Error(`Missing or stale dash-bored CLI installation: ${targetPath}`);
  } else {
    if (created) {
      await symlink(sourcePath, targetPath, "file");
    } else if (updated) {
      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      try {
        await symlink(sourcePath, temporaryPath, "file");
        if (await readlink(targetPath) !== previousLink) throw new Error(`CLI link changed during update: ${targetPath}`);
        await rename(temporaryPath, targetPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
    const nextReceipt = `${JSON.stringify({ sourcePath, version: APP_VERSION }, null, 2)}\n`;
    if (receiptText !== nextReceipt) {
      const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, nextReceipt, { flag: "wx", mode: 0o644 });
        if (receiptText === null) {
          // Exclusive creation cannot replace an unrelated receipt appearing mid-install.
          await writeFile(receiptPath, nextReceipt, { flag: "wx", mode: 0o644 });
        } else {
          if (await readFile(receiptPath, "utf8") !== receiptText) throw new Error(`CLI receipt changed during update: ${receiptPath}`);
          await rename(temporaryPath, receiptPath);
        }
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  const pathEntries = (options.pathValue ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return {
    sourcePath,
    targetPath,
    created,
    updated,
    targetDirectoryOnPath: pathEntries.includes(targetDirectory),
  };
}
