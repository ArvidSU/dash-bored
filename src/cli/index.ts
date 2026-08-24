#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { initializeProject } from "./init-project";
import { ensureProjectFiles, inspectProject } from "../core/index";
import type { Diagnostic, InspectResult } from "../shared/contracts";
import { APP_VERSION } from "../shared/app-metadata";
import { installDashBoredSkill } from "./install-skill";
import { installDashBoredCli } from "./install-cli";

const COMMANDS = new Set(["init", "install-cli", "install-skill", "open", "validate", "inspect"]);

interface ParsedCommandArguments {
  project: string;
  configName: string;
  json: boolean;
  help: boolean;
  error: string | null;
}

function usage(): string {
  return `dash-bored ${APP_VERSION}

Usage:
  dash-bored init [name ...] [--project <path>]
  dash-bored install-cli
  dash-bored install-skill [project]
  dash-bored open [project]
  dash-bored validate [project] [--json]
  dash-bored inspect [project]
  dash-bored --help
  dash-bored --version`;
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
      : "dash-bored";
    const stream = diagnostic.severity === "error" ? console.error : console.warn;
    stream(`${location} [${diagnostic.code}] ${diagnostic.message}`);
  }
}

function parseCommandArguments(
  command: string,
  args: string[],
): ParsedCommandArguments {
  const positional: string[] = [];
  let optionsEnabled = true;
  let json = false;
  let project = ".";
  let projectSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === "--help" || argument === "-h")) {
      return { project: ".", configName: ".", json: false, help: true, error: null };
    }
    if (optionsEnabled && command === "init" && argument === "--project") {
      if (projectSpecified) {
        return { project, configName: ".", json, help: false, error: "Option --project may be specified only once." };
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { project, configName: ".", json, help: false, error: "Option --project requires a path." };
      }
      project = value;
      projectSpecified = true;
      index += 1;
      continue;
    }
    if (optionsEnabled && command === "init" && argument.startsWith("--project=")) {
      if (projectSpecified) {
        return { project, configName: ".", json, help: false, error: "Option --project may be specified only once." };
      }
      project = argument.slice("--project=".length);
      if (project === "") {
        return { project: ".", configName: ".", json, help: false, error: "Option --project requires a path." };
      }
      projectSpecified = true;
      continue;
    }
    if (optionsEnabled && argument.startsWith("-")) {
      if (command === "validate" && argument === "--json") {
        if (json) {
          return { project: ".", configName: ".", json, help: false, error: "Option --json may be specified only once." };
        }
        json = true;
        continue;
      }
      return {
        project: ".",
        configName: ".",
        json,
        help: false,
        error: `Unknown option for ${command}: ${argument}`,
      };
    }
    positional.push(argument);
  }

  if (command !== "init" && positional.length > 1) {
    return {
      project: ".",
      configName: ".",
      json,
      help: false,
      error: `${command} accepts at most one project path.`,
    };
  }
  if (command === "install-cli" && positional.length > 0) {
    return {
      project: ".",
      configName: ".",
      json,
      help: false,
      error: "install-cli does not accept a project path.",
    };
  }
  return command === "init"
    ? { project, configName: positional.length === 0 ? "." : positional.join("/"), json, help: false, error: null }
    : { project: positional[0] ?? ".", configName: ".", json, help: false, error: null };
}

async function inspect(path: string, compile: boolean): Promise<InspectResult> {
  return inspectProject(path, { compile });
}

function sanitizedChildEnvironment(projectRoot: string, configPath: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("ELECTROBUN_") || key.startsWith("COTTONTAIL_ELECTROBUN_")) {
      continue;
    }
    environment[key] = value;
  }
  environment.DASH_BORED_PROJECT_ROOT = projectRoot;
  environment.DASH_BORED_CONFIG_PATH = configPath;
  return environment;
}

async function openProject(input: string): Promise<number> {
  const prepared = await ensureProjectFiles(input, {
    // A project root contains dash-bored/dash-bored.yaml. A bundle directory
    // contains dash-bored.yaml directly, so auto resolution can target either
    // the canonical dashboard or one standalone named dashboard.
    inputKind: "auto",
  });
  const result = await inspect(prepared.location.configPath, false);
  if (!result.ok) {
    printDiagnostics(result.diagnostics);
    return 1;
  }

  const configuredExecutable = process.env.DASH_BORED_APP_EXECUTABLE;
  const bundledCli = process.env.DASH_BORED_BUNDLED_CLI ?? process.execPath;
  const realCli = await realpath(bundledCli).catch(() => null);
  const discoveredExecutable = process.platform === "darwin" && realCli !== null
    ? resolve(dirname(realCli), "..", "..", "..", "MacOS", "launcher")
    : null;
  const appExecutable = configuredExecutable ?? discoveredExecutable;
  const packagedAppAvailable = appExecutable !== null
    && await access(appExecutable, constants.X_OK).then(() => true).catch(() => false);
  const packageRoot = resolve(import.meta.dirname, "../..");
  const child = packagedAppAvailable
    ? spawn(appExecutable, [], {
        cwd: result.projectRoot,
        env: sanitizedChildEnvironment(result.projectRoot, prepared.location.configPath),
        stdio: "inherit",
      })
    : spawn("bun", ["run", "dev"], {
        cwd: packageRoot,
        env: sanitizedChildEnvironment(result.projectRoot, prepared.location.configPath),
        stdio: "inherit",
      });

  const forward = (signal: NodeJS.Signals) => {
    if (child.pid) child.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      console.error(`Could not launch the dash-bored desktop app: ${error.message}`);
      resolveExit(1);
    });
    child.once("close", (code, signal) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (signal) resolveExit(1);
      else resolveExit(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(APP_VERSION);
    return 0;
  }

  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}\n`);
    console.error(usage());
    return 2;
  }

  const parsed = parseCommandArguments(command, args.slice(1));
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  if (parsed.error) {
    console.error(`${parsed.error}\n`);
    console.error(usage());
    return 2;
  }
  const project = parsed.project;

  if (command === "init") {
    const result = await initializeProject(project, parsed.configName);
    console.log(`Initialized dash-bored in ${result.projectRoot}`);
    console.log(result.configPath);
    console.log(result.lockPath);
    console.log(result.environmentPath);
    return 0;
  }

  if (command === "install-skill") {
    const result = await installDashBoredSkill(project);
    console.log(
      result.created.length === 0 && result.linked.length === 0
        ? `dash-bored skill is already installed in ${result.skillPath}`
        : `Installed portable dash-bored skill in ${result.skillPath}`,
    );
    console.log(`Claude Code compatibility path: ${result.claudeSkillPath}`);
    return 0;
  }

  if (command === "install-cli") {
    const result = await installDashBoredCli();
    console.log(
      result.created
        ? `Installed dash-bored CLI at ${result.targetPath}`
        : `dash-bored CLI is already installed at ${result.targetPath}`,
    );
    if (!result.targetDirectoryOnPath) {
      console.warn(`Add ${dirname(result.targetPath)} to PATH to use dash-bored from your shell.`);
    }
    return 0;
  }

  if (command === "validate") {
    const result = await inspect(project, true);
    if (parsed.json) {
      console.log(JSON.stringify({ ok: result.ok, diagnostics: result.diagnostics }, null, 2));
    } else if (result.ok) {
      console.log(`Valid dash-bored dashboard: ${result.projectRoot}`);
    } else {
      printDiagnostics(result.diagnostics);
    }
    return result.ok ? 0 : 1;
  }

  if (command === "inspect") {
    const result = await inspect(project, false);
    console.log(JSON.stringify(result, null, process.stdout.isTTY ? 2 : 0));
    return result.ok ? 0 : 1;
  }

  if (command === "open") {
    return openProject(project);
  }

  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
