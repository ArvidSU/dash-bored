import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DASH_BORED_SKILL_FILES, skillContentHash } from "./skill-payload";

import { LEGACY_SKILL_PAYLOADS } from "./legacy-skill-hashes";

const SKILL_FILES = Object.entries(DASH_BORED_SKILL_FILES);

export interface InstallSkillOptions {
  /** Install below the current user's home directory instead of a project. */
  global?: boolean;
  /** Read-only verification; rejects missing, stale, or conflicting installs. */
  check?: boolean;
  /** Override the home directory for tests or an explicitly selected user scope. */
  homeDirectory?: string;
}

export interface InstallSkillResult {
  projectRoot: string;
  skillPath: string;
  claudeSkillPath: string;
  created: string[];
  updated: string[];
  linked: string[];
}

async function ensureDirectory(path: string, label: string, check = false): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (check) throw new Error(`Missing ${label}: ${path}`);
    await mkdir(path);
  }
}

async function existingContents(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Skill target must be a regular file: ${path}`);
    }
    return readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeExclusiveAtomic(path: string, contents: string, previous: string | null = null): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o644,
  );
  let closed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    if (previous === null) {
      await link(temporaryPath, path);
    } else {
      if (await existingContents(path) !== previous) throw new Error(`Skill file changed during update: ${path}`);
      await rename(temporaryPath, path);
    }
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function existingSkillAlias(path: string, expectedTarget: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) {
      throw new Error(`Refusing to replace an existing agent skill path: ${path}`);
    }
    if (await realpath(path).catch(() => null) !== expectedTarget) {
      throw new Error(`Refusing to replace an existing agent skill link: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function installDashBoredSkill(
  projectInput = ".",
  options: InstallSkillOptions = {},
): Promise<InstallSkillResult> {
  const requestedRoot = resolve(
    options.global ? options.homeDirectory ?? homedir() : projectInput,
  );
  const rootInfo = await stat(requestedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `${options.global ? "Home" : "Project"} directory does not exist: ${requestedRoot}`,
      );
    }
    throw error;
  });
  if (!rootInfo.isDirectory()) {
    throw new Error(
      `${options.global ? "Home" : "Project"} path is not a directory: ${requestedRoot}`,
    );
  }

  const projectRoot = await realpath(requestedRoot);
  const agentsPath = join(projectRoot, ".agents");
  const skillsPath = join(agentsPath, "skills");
  const skillPath = join(skillsPath, "dash-bored");
  const claudePath = join(projectRoot, ".claude");
  const claudeSkillsPath = join(claudePath, "skills");
  const claudeSkillPath = join(claudeSkillsPath, "dash-bored");
  await ensureDirectory(agentsPath, "agent configuration directory", options.check);
  await ensureDirectory(skillsPath, "agent skills directory", options.check);
  await ensureDirectory(skillPath, "dash-bored skill directory", options.check);
  await ensureDirectory(claudePath, "Claude configuration directory", options.check);
  await ensureDirectory(claudeSkillsPath, "Claude skills directory", options.check);
  for (const relativePath of SKILL_FILES.map(([path]) => path)) {
    const directory = dirname(join(skillPath, relativePath));
    if (directory !== skillPath) {
      await ensureDirectory(directory, "dash-bored skill support directory", options.check);
    }
  }

  const receipt = await existingContents(join(skillPath, "skill-version.json"));
  let previousHashes: Record<string, string> = {};
  if (receipt !== null) {
    try {
      const value = JSON.parse(receipt);
      if (typeof value.skillVersion !== "string" || (value.files !== undefined &&
        (value.files === null || typeof value.files !== "object" || Array.isArray(value.files) ||
          !Object.values(value.files).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))))) throw new Error();
      previousHashes = value.files ?? {};
    } catch {
      throw new Error(`Invalid dash-bored skill receipt; preserve or move it before reinstalling: ${skillPath}/skill-version.json`);
    }
  }
  if (receipt === null) {
    for (const payload of LEGACY_SKILL_PAYLOADS) {
      const legacyMatches = await Promise.all(Object.entries(payload.files).map(async ([path, hash]) => {
        const contents = await existingContents(join(skillPath, path));
        return contents !== null && skillContentHash(contents) === hash;
      }));
      if (legacyMatches.every(Boolean)) {
        previousHashes = { ...payload.files };
        break;
      }
    }
  }
  const files = await Promise.all(SKILL_FILES.map(async ([relativePath, source]) => {
    const destination = join(skillPath, relativePath);
    const existing = await existingContents(destination);
    if (existing !== null && existing !== source && relativePath !== "skill-version.json" &&
      previousHashes[relativePath] !== skillContentHash(existing)) {
      throw new Error(`Refusing to overwrite a modified dash-bored skill file: ${destination}. Move your customized skill aside, then reinstall.`);
    }
    if (options.check && existing !== source) throw new Error(`Missing or stale dash-bored skill file: ${destination}`);
    return { relativePath, source, destination, existing };
  }));
  const aliasExists = await existingSkillAlias(claudeSkillPath, skillPath);

  if (options.check && !aliasExists) throw new Error(`Missing agent skill alias: ${claudeSkillPath}`);
  const created: string[] = [];
  const updated: string[] = [];
  for (const file of files) {
    if (file.existing === file.source) continue;
    try {
      await writeExclusiveAtomic(file.destination, file.source, file.existing);
      (file.existing === null ? created : updated).push(file.relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await existingContents(file.destination) !== file.source) {
        throw new Error(
          `Refusing to overwrite a modified dash-bored skill file: ${file.destination}`,
        );
      }
    }
  }

  const linked: string[] = [];
  if (!aliasExists) {
    const target = process.platform === "win32"
      ? skillPath
      : relative(claudeSkillsPath, skillPath);
    try {
      await symlink(target, claudeSkillPath, process.platform === "win32" ? "junction" : "dir");
      linked.push(claudeSkillPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!await existingSkillAlias(claudeSkillPath, skillPath)) throw error;
    }
  }

  return { projectRoot, skillPath, claudeSkillPath, created, updated, linked };
}
