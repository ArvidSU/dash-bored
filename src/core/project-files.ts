import {
  lstat,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parse, stringify } from "yaml";
import type {
  DashboardConfig,
  DashboardLock,
} from "../shared/contracts";
import { DEFAULT_COMPONENT_PACKAGE, DEFAULT_COMPONENT_PACKAGE_NAME } from "../shared/default-component-package";
import { loadPackageTemplates } from "./package-templates";
import { isOfflineStarterConfig, OFFLINE_STARTER_DIRECTORY, OFFLINE_STARTER_FILES, offlineStarterConfig } from "./offline-starter";
import { syncComponents } from "./external-components";
import { ensurePackageIgnore } from "./package-store";
import { CONFIG_DIRECTORY } from "../shared/contracts";
import { INSTALL_APP_SCRIPT, projectReadme } from "./project-readme";
import {
  assertProjectLocationContained,
  ensureDirectory,
  parseConfigName,
  resolveConfigBundleLocation,
  requireDirectory,
  resolveProjectLocation,
  type ProjectLocation,
  type ResolveProjectLocationOptions,
} from "./paths";
import { writeFileAtomically } from "./fs-atomic";

export interface ProjectFilesResult {
  location: ProjectLocation;
  environmentPath: string;
  readmePath: string;
  installerPath: string;
  created: {
    config: boolean;
    lock: boolean;
    environment: boolean;
    readme: boolean;
    installer: boolean;
    componentsDirectory: boolean;
  };
  /** Why the default dashboard was replaced by the offline placeholder. */
  defaultDashboardUnavailable?: string;
}

interface CreateProjectFilesOptions {
  existingFiles: "error" | "preserve";
  inputKind: NonNullable<ResolveProjectLocationOptions["inputKind"]>;
}

export type EnsureProjectFilesOptions = ResolveProjectLocationOptions;

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

async function writeExclusiveAtomic(path: string, contents: string, mode = 0o644): Promise<void> {
  await writeFileAtomically(path, contents, { mode, sync: true, exclusive: true });
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

  await writeFileAtomically(
    location.configPath,
    stringify(config, { lineWidth: 0 }),
    { mode: 0o644, sync: true },
  );
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
  await requireDirectory(location.projectRoot, "Project");

  await ensureDirectory(location.configDirectory, "dash-bored directory");
  const componentsDirectory = await ensureDirectory(
    location.componentsDirectory,
    "dash-bored components directory",
  );
  await assertProjectLocationContained(location);
  await ensurePackageIgnore(location.configDirectory);
  const environmentPath = join(location.configDirectory, ".env");
  const readmePath = join(location.configDirectory, "README.md");
  const installerPath = join(location.configDirectory, "install-app.sh");
  const relativeEnvironmentPath = relative(location.projectRoot, environmentPath).replaceAll("\\", "/");
  const [configExists, lockExists, environmentExists, readmeExists, installerExists] = await Promise.all([
    existingFile(location.configPath, "dash-bored configuration"),
    existingFile(location.lockPath, "dash-bored lock file"),
    existingFile(environmentPath, "dash-bored environment file"),
    existingFile(readmePath, "dash-bored README"),
    existingFile(installerPath, "dash-bored installer helper"),
  ]);

  // An untouched offline placeholder is the one existing config init may replace.
  const replacingPlaceholder = existingFiles === "error" && configExists
    && isOfflineStarterConfig(await readFile(location.configPath, "utf8").then((text) => parse(text) as unknown).catch(() => null));
  if (replacingPlaceholder) existingFiles = "preserve";
  if (existingFiles === "error" && (configExists || lockExists || environmentExists)) {
    throw new Error(
      `dash-bored is already initialized or partially initialized in ${location.configDirectory}; existing files were not overwritten.`,
    );
  }

  const lock: DashboardLock = { lockfileVersion: 1, components: { [DEFAULT_COMPONENT_PACKAGE_NAME]: { ...DEFAULT_COMPONENT_PACKAGE } } };
  const environment = [
    "# Values shown in the dashboard environment editor.",
    "# Optional: DASH_BORED_AGENT names the ACP agent command for this dashboard,",
    "# such as claude-agent-acp, codex-acp, or \"gemini --acp\". Settings → General →",
    "# Dashboard agent overrides it; when neither is set, the app uses a detected agent.",
    "# DASH_BORED_AGENT=\"codex-acp\"",
    "",
  ].join("\n");
  let configCreated = false;
  let lockCreated = false;
  let environmentCreated = false;
  let readmeCreated = false;
  let installerCreated = false;
  const placeholderFiles: string[] = [];
  let defaultDashboardUnavailable: string | undefined;

  try {

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

    if (!configExists || replacingPlaceholder) {
      const projectName = basename(location.configDirectory === join(location.projectRoot, CONFIG_DIRECTORY)
        ? location.projectRoot : location.configDirectory) || "Project";
      let config: DashboardConfig;
      try {
        // Default distribution is package data, not a component registry or a
        // source of privileged runtime behavior. Restore before reading its template.
        await syncComponents(location.configPath, { missingOnly: true });
        const packageDirectory = join(location.configDirectory, DEFAULT_COMPONENT_PACKAGE.path);
        const templates = await loadPackageTemplates(packageDirectory, `./${DEFAULT_COMPONENT_PACKAGE.path}`, {
          projectName,
          environmentPath: relativeEnvironmentPath,
        });
        const starter = templates.find((template) => template.role === "starter" && template.config);
        if (!starter?.config) throw new Error("The default component package has no starter dashboard template.");
        config = starter.config;
      } catch (error) {
        // Re-init only upgrades a placeholder; it never writes a second one.
        if (replacingPlaceholder) throw error;
        // Git output repeats temporary paths; its last line names the cause.
        const detail = (error instanceof Error ? error.message : String(error)).trim().split("\n")
          .map((line) => line.trim()).filter(Boolean);
        const cause = detail.findLast((line) => /^(fatal|error):/i.test(line)) ?? detail.at(-1) ?? "Unknown error";
        defaultDashboardUnavailable = `Could not restore the default component package: ${cause}`;
        const directory = join(location.componentsDirectory, OFFLINE_STARTER_DIRECTORY);
        if (await ensureDirectory(directory, "offline starter component directory")) placeholderFiles.push(directory);
        for (const [name, contents] of Object.entries(OFFLINE_STARTER_FILES)) {
          const path = join(directory, name);
          if (await existingFile(path, "offline starter component file")) continue;
          await writeExclusiveAtomic(path, contents);
          placeholderFiles.unshift(path);
        }
        config = offlineStarterConfig(projectName, defaultDashboardUnavailable);
      }

      if (replacingPlaceholder) {
        await writeFileAtomically(location.configPath, stringify(config, { lineWidth: 0 }), { mode: 0o644, sync: true });
      } else try {
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

    if (!environmentExists) {
      try {
        await writeExclusiveAtomic(environmentPath, environment, 0o600);
        environmentCreated = true;
      } catch (error) {
        if (
          existingFiles !== "preserve" ||
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await existingFile(environmentPath, "dash-bored environment file"))
        ) {
          throw error;
        }
      }
    }

    // These are project-owned guidance, so preserve them even during explicit init.
    for (const [path, exists, contents, label] of [
      [readmePath, readmeExists, projectReadme(location), "dash-bored README"],
      [installerPath, installerExists, INSTALL_APP_SCRIPT, "dash-bored installer helper"],
    ] as const) {
      if (exists) continue;
      try {
        await writeExclusiveAtomic(path, contents);
        if (path === readmePath) readmeCreated = true;
        else installerCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await existingFile(path, label))) throw error;
      }
    }
  } catch (error) {
    if (installerCreated) await unlink(installerPath).catch(() => undefined);
    if (readmeCreated) await unlink(readmePath).catch(() => undefined);
    if (environmentCreated) await unlink(environmentPath).catch(() => undefined);
    if (lockCreated) await unlink(location.lockPath).catch(() => undefined);
    if (configCreated) await unlink(location.configPath).catch(() => undefined);
    // Files first, then the directory if this run created it.
    for (const path of placeholderFiles) await rm(path, { force: true }).catch(() => rmdir(path)).catch(() => undefined);
    throw error;
  }

  return {
    location,
    environmentPath,
    readmePath,
    installerPath,
    created: {
      config: configCreated,
      lock: lockCreated,
      environment: environmentCreated,
      readme: readmeCreated,
      installer: installerCreated,
      componentsDirectory,
    },
    ...(defaultDashboardUnavailable === undefined ? {} : { defaultDashboardUnavailable }),
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

/** Initialize a project and fail rather than accepting an existing bundle artifact. */
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
