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
import { basename, join, relative } from "node:path";
import { stringify } from "yaml";
import type {
  ComponentChildLayout,
  ComponentNode,
  DashboardConfig,
  DashboardLock,
} from "../shared/contracts";
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
  environmentPath: string;
  created: {
    config: boolean;
    lock: boolean;
    environment: boolean;
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

async function writeExclusiveAtomic(path: string, contents: string, mode = 0o644): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
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

function starterAgentPrompt(projectName: string): string {
  return [
    `Set up the dash-bored dashboard for ${projectName}.`,
    "Inspect this project before making changes.",
    "Use the installed portable dash-bored skill for product-specific guidance.",
    "Customize the dash-bored configuration that contains the node id setup-dashboard-with-agent into a useful project cockpit.",
    "Keep the dashboard project-owned and task-focused: expose important status, documentation, and repeatable workflows with built-in components where possible, and add small local components only when they are genuinely useful.",
    "Follow AGENTS.md and the project's own instructions, preserve unrelated changes, validate the finished dashboard, and summarize what you changed.",
  ].join(" ");
}

function formatDotenvValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

function defaultConfig(bundleNameSource: string, environmentPath: string): DashboardConfig {
  const projectName = basename(bundleNameSource) || "Project";
  const agentPrompt = starterAgentPrompt(projectName);
  const child = (node: ComponentNode): ComponentChildLayout => ({
    type: "child",
    child: { node },
  });
  const vertical = (nodes: ComponentNode[]): ComponentChildLayout => {
    if (nodes.length === 1) return child(nodes[0]!);
    const middle = Math.ceil(nodes.length / 2);
    return {
      type: "split",
      axis: "vertical",
      ratio: middle / nodes.length,
      first: vertical(nodes.slice(0, middle)),
      second: vertical(nodes.slice(middle)),
    };
  };
  const tiled = (layout: ComponentChildLayout) => ({ type: "tiled" as const, layout });
  const howItWorks: ComponentNode = {
    id: "how-it-works",
    component: "@dash-bored/card",
    props: {
      title: "How it works",
      description: "A small YAML tree becomes your project cockpit.",
    },
    children: tiled(child({
      component: "@dash-bored/markdown",
      props: {
        content: "1. Compose generic components in `dash-bored/dash-bored.yaml`.\n2. Trust the project when it needs files, network access, or commands.\n3. Keep improving the dashboard as project friction appears.\n",
      },
    })),
  };
  const availableComponents: ComponentNode = {
    id: "available-components",
    component: "@dash-bored/card",
    props: {
      title: "What you can add",
      description: "Start with built-ins; generate a local component for project-specific needs.",
    },
    children: tiled(child({
      component: "@dash-bored/markdown",
      props: {
        content: "**Layout:** recursive horizontal and vertical tiles, tabs, and cards  \n**Display:** Markdown, text, status, files, and webviews  \n**Workflow:** commands, live output, and environment editing  \n**Custom:** React components under `dash-bored/components/`\n",
      },
    })),
  };
  const agentSetupChildren: ComponentNode[] = [
    {
      component: "@dash-bored/markdown",
      props: {
        content: "Choose your CLI agent once in application Settings. The app puts its matching dash-bored CLI on PATH for dashboard commands; optionally install a shell link for use outside the app. Install the portable Agent Skill globally for all projects, or only in this project so Codex, Claude Code, Gemini CLI, Cursor, Copilot CLI, and OpenCode can discover the component model and safe workflow. Finally, run the setup command to ask the agent to inspect this project and build a useful dashboard. Review each command and trust the project when you are ready.\n",
      },
    },
    { id: "dashboard-environment", component: "@dash-bored/env", props: { path: environmentPath } },
    {
      id: "install-dash-bored-cli",
      component: "@dash-bored/command",
      props: {
        label: "Install dash-bored CLI in ~/.local/bin",
        command: "dash-bored install-cli",
        cwd: ".",
      },
    },
    {
      id: "install-dash-bored-global-skill",
      component: "@dash-bored/command",
      props: {
        label: "Install dash-bored skill globally",
        command: "dash-bored install-skill --global",
        cwd: ".",
      },
    },
    {
      id: "install-dash-bored-skill",
      component: "@dash-bored/command",
      props: {
        label: "Install portable dash-bored skill for this project",
        command: "dash-bored install-skill .",
        cwd: ".",
      },
    },
    {
      id: "setup-dashboard-with-agent",
      component: "@dash-bored/command",
      props: {
        label: "Set up this dashboard",
        command: 'dash-bored agent "${DASH_BORED_AGENT:-codex exec}"',
        cwd: ".",
        env: { DASH_BORED_AGENT_PROMPT: agentPrompt },
      },
    },
  ];
  const rootNodes: ComponentNode[] = [
    {
      id: "welcome",
      component: "@dash-bored/markdown",
      props: {
        content: `# ${projectName}\n\nThis dashboard lives with your project. Use it to keep the commands, context, and tools you reach for close at hand.\n\nPress **Command-K** to find dashboard actions, or choose **Components** to arrange components and configure their props.\n`,
      },
    },
    {
      id: "getting-started",
      component: "@dash-bored/group",
      children: tiled({
        type: "split",
        axis: "horizontal",
        ratio: 0.42,
        first: child(howItWorks),
        second: child(availableComponents),
      }),
    },
    {
      id: "agent-setup",
      component: "@dash-bored/card",
      props: {
        title: "Make it yours",
        description: "Hand the repetitive setup work to your CLI coding agent.",
      },
      children: tiled(vertical(agentSetupChildren)),
    },
  ];
  return {
    schemaVersion: 2,
    name: projectName,
    root: {
      component: "@dash-bored/group",
      children: tiled(vertical(rootNodes)),
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
  const environmentPath = join(location.configDirectory, ".env");
  const relativeEnvironmentPath = relative(location.projectRoot, environmentPath).replaceAll("\\", "/");
  const [configExists, lockExists, environmentExists] = await Promise.all([
    existingFile(location.configPath, "dash-bored configuration"),
    existingFile(location.lockPath, "dash-bored lock file"),
    existingFile(environmentPath, "dash-bored environment file"),
  ]);

  if (existingFiles === "error" && (configExists || lockExists || environmentExists)) {
    throw new Error(
      `dash-bored is already initialized or partially initialized in ${location.configDirectory}; existing files were not overwritten.`,
    );
  }

  const config = defaultConfig(
    location.configDirectory === join(location.projectRoot, CONFIG_DIRECTORY)
      ? location.projectRoot
      : location.configDirectory,
    relativeEnvironmentPath,
  );
  const projectName = location.configDirectory === join(location.projectRoot, CONFIG_DIRECTORY)
    ? basename(location.projectRoot) || "Project"
    : basename(location.configDirectory) || "Project";
  const agentPrompt = starterAgentPrompt(projectName);
  const lock: DashboardLock = { lockfileVersion: 1, components: {} };
  const environment = [
    "# Starter values shown in the dashboard environment editor.",
    "# DASH_BORED_AGENT is also configurable app-wide in Settings.",
    `DASH_BORED_AGENT=${formatDotenvValue("codex exec")}`,
    `DASH_BORED_AGENT_PROMPT=${formatDotenvValue(agentPrompt)}`,
    "",
  ].join("\n");
  let configCreated = false;
  let lockCreated = false;
  let environmentCreated = false;

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
  } catch (error) {
    if (environmentCreated) await unlink(environmentPath).catch(() => undefined);
    if (lockCreated) await unlink(location.lockPath).catch(() => undefined);
    if (configCreated) await unlink(location.configPath).catch(() => undefined);
    throw error;
  }

  return {
    location,
    environmentPath,
    created: {
      config: configCreated,
      lock: lockCreated,
      environment: environmentCreated,
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
