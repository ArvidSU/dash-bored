import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import type { DashboardConfig, DashboardLock } from "../shared/contracts";
import { CONFIG_DIRECTORY } from "../shared/contracts";
import {
  assertProjectLocationContained,
  parseConfigName,
  resolveConfigBundleLocation,
  resolveProjectLocation,
  type ProjectLocation,
  type ResolveProjectLocationOptions,
} from "./paths";

export interface ProjectFilesResult {
  location: ProjectLocation;
  created: {
    config: boolean;
    lock: boolean;
    componentsDirectory: boolean;
  };
}

interface CreateProjectFilesOptions {
  existingFiles: "error" | "preserve";
  inputKind: NonNullable<ResolveProjectLocationOptions["inputKind"]>;
}

export type EnsureProjectFilesOptions = ResolveProjectLocationOptions;

async function requireProjectDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${path}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`Project path is not a directory: ${path}`);
  }
}

async function ensureDirectory(path: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path);
    return true;
  }
}

async function existingFile(path: string, label: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
    // A same-directory hard link publishes the complete file atomically and
    // fails with EEXIST rather than replacing a file created concurrently.
    await link(temporaryPath, path);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function replaceDashboardConfigAtomic(
  location: ProjectLocation,
  config: DashboardConfig,
): Promise<void> {
  await assertProjectLocationContained(location);
  const existing = await lstat(location.configPath);
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error(`dash-bored configuration must be a regular file: ${location.configPath}`);
  }

  const temporaryPath = `${location.configPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o644,
  );
  let closed = false;
  try {
    await handle.writeFile(stringify(config, { lineWidth: 0 }), "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporaryPath, location.configPath);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function defaultConfig(bundleNameSource: string): DashboardConfig {
  const projectName = basename(bundleNameSource) || "Project";
  return {
    schemaVersion: 1,
    name: projectName,
    root: {
      component: "@dash-bored/stack",
      props: { gap: "medium" },
      slots: {
        children: [
          {
            id: "welcome",
            component: "@dash-bored/markdown",
            props: {
              content: `# ${projectName}\n\nYour dash-bored dashboard is ready.\n\nAdd config-specific components under \`components/\`.\n`,
            },
          },
        ],
      },
    },
  };
}

async function createProjectFiles(
  input: string,
  options: CreateProjectFilesOptions,
): Promise<ProjectFilesResult> {
  const location = await resolveProjectLocation(input, {
    inputKind: options.inputKind,
  });
  return createProjectFilesAtLocation(location, options.existingFiles);
}

async function createProjectFilesAtLocation(
  location: ProjectLocation,
  existingFiles: CreateProjectFilesOptions["existingFiles"],
): Promise<ProjectFilesResult> {
  await requireProjectDirectory(location.projectRoot);

  await ensureDirectory(location.configDirectory, "dash-bored directory");
  const componentsDirectory = await ensureDirectory(
    location.componentsDirectory,
    "dash-bored components directory",
  );
  await assertProjectLocationContained(location);
  const [configExists, lockExists] = await Promise.all([
    existingFile(location.configPath, "dash-bored configuration"),
    existingFile(location.lockPath, "dash-bored lock file"),
  ]);

  if (existingFiles === "error" && (configExists || lockExists)) {
    throw new Error(
      `dash-bored is already initialized or partially initialized in ${location.configDirectory}; existing files were not overwritten.`,
    );
  }

  const config = defaultConfig(location.configDirectory === join(location.projectRoot, CONFIG_DIRECTORY)
    ? location.projectRoot
    : location.configDirectory);
  const lock: DashboardLock = { lockfileVersion: 1, components: {} };
  let configCreated = false;
  let lockCreated = false;

  try {
    if (!configExists) {
      try {
        await writeExclusiveAtomic(
          location.configPath,
          stringify(config, { lineWidth: 0 }),
        );
        configCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(location.configPath, "dash-bored configuration"))
        ) {
          throw error;
        }
      }
    }

    if (!lockExists) {
      try {
        await writeExclusiveAtomic(
          location.lockPath,
          stringify(lock, { lineWidth: 0 }),
        );
        lockCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(location.lockPath, "dash-bored lock file"))
        ) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (lockCreated) await unlink(location.lockPath).catch(() => undefined);
    if (configCreated) await unlink(location.configPath).catch(() => undefined);
    throw error;
  }

  return {
    location,
    created: {
      config: configCreated,
      lock: lockCreated,
      componentsDirectory,
    },
  };
}

/** Create only missing dash-bored project artifacts, preserving existing files. */
export function ensureProjectFiles(
  input = ".",
  options: EnsureProjectFilesOptions = {},
): Promise<ProjectFilesResult> {
  return createProjectFiles(input, {
    existingFiles: "preserve",
    inputKind: options.inputKind ?? "auto",
  });
}

/** Initialize a project and fail rather than accepting an existing config or lock file. */
export function initializeProjectFiles(input = "."): Promise<ProjectFilesResult> {
  return createProjectFiles(input, {
    existingFiles: "error",
    inputKind: "project-root",
  });
}

/**
 * Initialize a standalone named configuration bundle. The base bundle is
 * repaired first so every named config lives inside a complete project layout.
 */
export async function initializeNamedProjectFiles(
  projectInput = ".",
  name: string,
): Promise<ProjectFilesResult> {
  const segments = parseConfigName(name);
  if (segments.length === 0) return initializeProjectFiles(projectInput);

  const base = await ensureProjectFiles(projectInput, { inputKind: "project-root" });
  let directory = base.location.configDirectory;
  for (const segment of segments) {
    directory = join(directory, segment);
    await ensureDirectory(directory, "named dash-bored config directory");
  }

  const location = await resolveConfigBundleLocation(projectInput, name);
  return createProjectFilesAtLocation(location, "error");
}
