import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { DASH_BORED_SKILL_FILES } from "./skill-payload";

const SKILL_FILES = Object.entries(DASH_BORED_SKILL_FILES);

export interface InstallSkillResult {
  projectRoot: string;
  skillPath: string;
  claudeSkillPath: string;
  created: string[];
  linked: string[];
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

async function writeExclusiveAtomic(path: string, contents: string): Promise<void> {
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
    await link(temporaryPath, path);
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

export async function installDashBoredSkill(projectInput = "."): Promise<InstallSkillResult> {
  const requestedRoot = resolve(projectInput);
  const rootInfo = await stat(requestedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Project directory does not exist: ${requestedRoot}`);
    throw error;
  });
  if (!rootInfo.isDirectory()) throw new Error(`Project path is not a directory: ${requestedRoot}`);

  const projectRoot = await realpath(requestedRoot);
  const agentsPath = join(projectRoot, ".agents");
  const skillsPath = join(agentsPath, "skills");
  const skillPath = join(skillsPath, "dash-bored");
  const claudePath = join(projectRoot, ".claude");
  const claudeSkillsPath = join(claudePath, "skills");
  const claudeSkillPath = join(claudeSkillsPath, "dash-bored");
  await ensureDirectory(agentsPath, "agent configuration directory");
  await ensureDirectory(skillsPath, "agent skills directory");
  await ensureDirectory(skillPath, "dash-bored skill directory");
  await ensureDirectory(claudePath, "Claude configuration directory");
  await ensureDirectory(claudeSkillsPath, "Claude skills directory");
  for (const relativePath of SKILL_FILES.map(([path]) => path)) {
    const directory = dirname(join(skillPath, relativePath));
    if (directory !== skillPath) {
      await ensureDirectory(directory, "dash-bored skill support directory");
    }
  }

  const files = await Promise.all(SKILL_FILES.map(async ([relativePath, source]) => {
    const destination = join(skillPath, relativePath);
    const existing = await existingContents(destination);
    if (existing !== null && existing !== source) {
      throw new Error(
        `Refusing to overwrite a modified dash-bored skill file: ${destination}`,
      );
    }
    return { relativePath, source, destination, existing };
  }));
  const aliasExists = await existingSkillAlias(claudeSkillPath, skillPath);

  const created: string[] = [];
  for (const file of files) {
    if (file.existing !== null) continue;
    try {
      await writeExclusiveAtomic(file.destination, file.source);
      created.push(file.relativePath);
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

  return { projectRoot, skillPath, claudeSkillPath, created, linked };
}
