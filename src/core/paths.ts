import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  COMPONENTS_DIRECTORY,
  CONFIG_DIRECTORY,
  CONFIG_FILE,
  LOCK_FILE,
} from "../shared/contracts";
import { CoreError } from "./diagnostics";

export interface ProjectLocation {
  projectRoot: string;
  configDirectory: string;
  configPath: string;
  lockPath: string;
  componentsDirectory: string;
}

export interface ResolveProjectLocationOptions {
  inputKind?: "auto" | "project-root";
}

const CONFIG_NAME_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Parse a slash-separated named configuration path below dash-bored/. */
export function parseConfigName(name: string): string[] {
  if (name === ".") return [];
  if (
    name.trim() === "" ||
    name.includes("\0") ||
    isAbsolute(name) ||
    name.includes("\\")
  ) {
    throw new CoreError(
      "CONFIG_NAME_INVALID",
      "A config name must be '.' or a relative slash-separated name.",
    );
  }

  const segments = name.split("/");
  if (
    segments.some(
      (segment) =>
        !CONFIG_NAME_SEGMENT.test(segment) ||
        segment === COMPONENTS_DIRECTORY ||
        segment === CONFIG_DIRECTORY,
    )
  ) {
    throw new CoreError(
      "CONFIG_NAME_INVALID",
      `Invalid config name: ${name}. Segments must start with a letter, contain only letters, digits, '_' or '-', and must not be '${COMPONENTS_DIRECTORY}' or '${CONFIG_DIRECTORY}'.`,
    );
  }
  return segments;
}

/** Resolve a standalone base or named configuration bundle in a project. */
export async function resolveConfigBundleLocation(
  projectInput: string,
  name = ".",
): Promise<ProjectLocation> {
  const base = await resolveProjectLocation(projectInput, { inputKind: "project-root" });
  const segments = parseConfigName(name);
  if (segments.length === 0) return base;

  const configDirectory = join(base.configDirectory, ...segments);
  return {
    projectRoot: base.projectRoot,
    configDirectory,
    configPath: join(configDirectory, CONFIG_FILE),
    lockPath: join(configDirectory, LOCK_FILE),
    componentsDirectory: join(configDirectory, COMPONENTS_DIRECTORY),
  };
}

/** Ensure project configuration paths do not escape through top-level symlinks. */
export async function assertProjectLocationContained(location: ProjectLocation): Promise<void> {
  for (const path of [
    location.configDirectory,
    location.configPath,
    location.lockPath,
    location.componentsDirectory,
  ]) {
    const requested = relative(location.projectRoot, path);
    await resolveContainedPath(location.projectRoot, requested, { mustExist: false });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalizeExistingAncestor(path: string): Promise<string> {
  const absolute = resolve(path);
  let cursor = absolute;
  const missing: string[] = [];

  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(basename(cursor));
    cursor = parent;
  }

  return join(await realpath(cursor), ...missing);
}

/**
 * Resolve a project root, its dash-bored directory, or dash-bored.yaml into
 * the canonical paths consumed by the rest of the core.
 */
export async function resolveProjectLocation(
  input: string,
  options: ResolveProjectLocationOptions = {},
): Promise<ProjectLocation> {
  if (input.trim() === "") {
    throw new CoreError("PROJECT_PATH_EMPTY", "The project path cannot be empty.");
  }

  const absolute = resolve(input);
  let projectRoot: string;
  let configDirectory: string;
  let bundleSegments: string[] = [];

  if (options.inputKind === "project-root") {
    projectRoot = absolute;
    configDirectory = join(absolute, CONFIG_DIRECTORY);
  } else if (basename(absolute) === CONFIG_FILE) {
    configDirectory = dirname(absolute);
    let configRoot = configDirectory;
    while (basename(configRoot) !== CONFIG_DIRECTORY && dirname(configRoot) !== configRoot) {
      configRoot = dirname(configRoot);
    }
    if (basename(configRoot) !== CONFIG_DIRECTORY) {
      throw new CoreError(
        "CONFIG_LOCATION_INVALID",
        `${CONFIG_FILE} must be inside a ${CONFIG_DIRECTORY}/ configuration tree.`,
      );
    }
    projectRoot = dirname(configRoot);
    const bundlePath = relative(configRoot, configDirectory);
    bundleSegments = bundlePath === "" ? [] : bundlePath.split(sep);
  } else {
    const inputStats = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (inputStats?.isFile()) {
      throw new CoreError(
        "PROJECT_PATH_INVALID",
        `Expected a project directory, ${CONFIG_DIRECTORY}/ directory, or ${CONFIG_FILE}.`,
      );
    }

    const directConfig = join(absolute, CONFIG_FILE);
    const nestedConfig = join(absolute, CONFIG_DIRECTORY, CONFIG_FILE);
    if (await exists(directConfig)) {
      configDirectory = absolute;
      let configRoot = configDirectory;
      while (basename(configRoot) !== CONFIG_DIRECTORY && dirname(configRoot) !== configRoot) {
        configRoot = dirname(configRoot);
      }
      if (basename(configRoot) !== CONFIG_DIRECTORY) {
        throw new CoreError(
          "CONFIG_LOCATION_INVALID",
          `${CONFIG_FILE} must be inside a ${CONFIG_DIRECTORY}/ configuration tree.`,
        );
      }
      projectRoot = dirname(configRoot);
      const bundlePath = relative(configRoot, configDirectory);
      bundleSegments = bundlePath === "" ? [] : bundlePath.split(sep);
    } else if (await exists(nestedConfig)) {
      projectRoot = absolute;
      configDirectory = join(absolute, CONFIG_DIRECTORY);
    } else if (basename(absolute) === CONFIG_DIRECTORY) {
      configDirectory = absolute;
      projectRoot = dirname(absolute);
    } else {
      projectRoot = absolute;
      configDirectory = join(absolute, CONFIG_DIRECTORY);
    }
  }

  projectRoot = await canonicalizeExistingAncestor(projectRoot);
  configDirectory = join(projectRoot, CONFIG_DIRECTORY, ...bundleSegments);

  return {
    projectRoot,
    configDirectory,
    configPath: join(configDirectory, CONFIG_FILE),
    lockPath: join(configDirectory, LOCK_FILE),
    componentsDirectory: join(configDirectory, COMPONENTS_DIRECTORY),
  };
}

export function isPathContained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export interface ResolveContainedPathOptions {
  mustExist?: boolean;
  kind?: "file" | "directory" | "any";
}

/** Resolve a user-controlled relative path without permitting symlink escapes. */
export async function resolveContainedPath(
  root: string,
  requestedPath: string,
  options: ResolveContainedPathOptions = {},
): Promise<string> {
  if (requestedPath.trim() === "" || requestedPath.includes("\0") || isAbsolute(requestedPath)) {
    throw new CoreError("PATH_OUTSIDE_PROJECT", "The path must be a non-empty relative path.");
  }

  const canonicalRoot = await canonicalizeExistingAncestor(root);
  const lexicalPath = resolve(canonicalRoot, requestedPath);
  if (!isPathContained(canonicalRoot, lexicalPath)) {
    throw new CoreError("PATH_OUTSIDE_PROJECT", "The path resolves outside the allowed directory.");
  }

  const pathExists = await exists(lexicalPath);
  if (!pathExists) {
    if (options.mustExist ?? true) {
      throw new CoreError("PATH_NOT_FOUND", `Path does not exist: ${requestedPath}`);
    }
    const canonicalMissing = await canonicalizeExistingAncestor(lexicalPath);
    if (!isPathContained(canonicalRoot, canonicalMissing)) {
      throw new CoreError("PATH_OUTSIDE_PROJECT", "The path resolves outside the allowed directory.");
    }
    return canonicalMissing;
  }

  const canonicalPath = await realpath(lexicalPath);
  if (!isPathContained(canonicalRoot, canonicalPath)) {
    throw new CoreError("PATH_OUTSIDE_PROJECT", "The path resolves outside the allowed directory.");
  }

  const expectedKind = options.kind ?? "any";
  if (expectedKind !== "any") {
    const value = await stat(canonicalPath);
    if (expectedKind === "file" && !value.isFile()) {
      throw new CoreError("PATH_NOT_FILE", `Expected a file: ${requestedPath}`);
    }
    if (expectedKind === "directory" && !value.isDirectory()) {
      throw new CoreError("PATH_NOT_DIRECTORY", `Expected a directory: ${requestedPath}`);
    }
  }

  return canonicalPath;
}
