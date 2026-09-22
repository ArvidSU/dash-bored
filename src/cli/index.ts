#!/usr/bin/env bun
/**
 * The dash-bored agent tool. It ships inside the desktop app and is invoked by
 * agents through the skill's launcher; users work through the app instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runThemeCommand } from "./theme";
import { initializeProject } from "./init-project";
import { inspectProject } from "../core/index";
import { runComponentCommand } from "./component";
import { runAppCommand } from "./app";
import { runMigrateCommand } from "./migrate";
import type { Diagnostic, InspectResult } from "../shared/contracts";
import { APP_VERSION } from "../shared/app-metadata";
import { installDashBoredSkill } from "./install-skill";

const COMMANDS = new Set(["init", "install-skill", "validate", "inspect", "component", "theme", "migrate", "app"]);

interface ParsedCommandArguments {
  project: string;
  configName: string;
  json: boolean;
  global: boolean;
  help: boolean;
  error: string | null;
}

function usage(): string {
  return `dash-bored agent tool ${APP_VERSION}

Usage:
  dash-bored init [name ...] [--project <path>]
  dash-bored install-skill [project] [--global] [--check]
  dash-bored validate [project] [--json]
  dash-bored inspect [project] [--summary | --component <reference>]
  dash-bored app <status|actions|run|open|screenshot> [--instance <identifier>]
  dash-bored theme <init|validate|list|status|add|update|remove|sync> [--global]
  dash-bored component add <url> [--name <name>] [--ref <ref>] [project]
  dash-bored component list [project]
  dash-bored component status [<name>] [project]
  dash-bored component update <name> [--to <ref>] [project]
  dash-bored component remove <name> [project]
  dash-bored component sync [project]
  dash-bored migrate inspect <dashboard>
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
  let global = false;
  let project = ".";
  let projectSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === "--help" || argument === "-h")) {
      return { project: ".", configName: ".", json: false, global: false, help: true, error: null };
    }
    if (optionsEnabled && command === "init" && argument === "--project") {
      if (projectSpecified) {
        return { project, configName: ".", json, global, help: false, error: "Option --project may be specified only once." };
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { project, configName: ".", json, global, help: false, error: "Option --project requires a path." };
      }
      project = value;
      projectSpecified = true;
      index += 1;
      continue;
    }
    if (optionsEnabled && command === "init" && argument.startsWith("--project=")) {
      if (projectSpecified) {
        return { project, configName: ".", json, global, help: false, error: "Option --project may be specified only once." };
      }
      project = argument.slice("--project=".length);
      if (project === "") {
        return { project: ".", configName: ".", json, global, help: false, error: "Option --project requires a path." };
      }
      projectSpecified = true;
      continue;
    }
    if (optionsEnabled && command === "install-skill" && argument === "--global") {
      if (global) {
        return { project: ".", configName: ".", json, global, help: false, error: "Option --global may be specified only once." };
      }
      global = true;
      continue;
    }
    if (optionsEnabled && argument.startsWith("-")) {
      if (command === "validate" && argument === "--json") {
        if (json) {
          return { project: ".", configName: ".", json, global, help: false, error: "Option --json may be specified only once." };
        }
        json = true;
        continue;
      }
      return {
        project: ".",
        configName: ".",
        json,
        global,
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
      global,
      help: false,
      error: `${command} accepts at most one project path.`,
    };
  }
  if (command === "install-skill" && global && positional.length > 0) {
    return {
      project: ".",
      configName: ".",
      json,
      global,
      help: false,
      error: "install-skill --global does not accept a project path.",
    };
  }
  return command === "init"
    ? { project, configName: positional.length === 0 ? "." : positional.join("/"), json, global, help: false, error: null }
    : { project: positional[0] ?? ".", configName: ".", json, global, help: false, error: null };
}

async function inspect(path: string, compile: boolean): Promise<InspectResult> {
  return inspectProject(path, { compile });
}

/**
 * The skill launcher names its directory; warn when that installed guidance
 * was written for another version than this tool.
 */
async function warnOnSkillVersionMismatch(): Promise<void> {
  const skillDirectory = process.env.DASH_BORED_SKILL_DIR;
  if (!skillDirectory) return;
  try {
    const receipt = JSON.parse(await readFile(join(skillDirectory, "skill-version.json"), "utf8")) as { skillVersion?: unknown };
    if (typeof receipt.skillVersion === "string" && receipt.skillVersion !== APP_VERSION) {
      console.error(`dash-bored: the skill in ${skillDirectory} is ${receipt.skillVersion} but the app's tool is ${APP_VERSION}. Reinstall the skill with \`dash-bored install-skill\` or ask the user to open the app, which refreshes owned skills.`);
    }
  } catch {
    // A source checkout or customized skill has no receipt; nothing to compare.
  }
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

  await warnOnSkillVersionMismatch();
  if (command === "migrate") return runMigrateCommand(args.slice(1));
  if (command === "app") return runAppCommand(args.slice(1));

  const commandArgs = args.slice(1);
  const checkIndex = command === "install-skill" ? commandArgs.indexOf("--check") : -1;
  const separatorIndex = commandArgs.indexOf("--");
  const check = checkIndex >= 0 && (separatorIndex < 0 || checkIndex < separatorIndex);
  if (check) commandArgs.splice(checkIndex, 1);
  let summary = false;
  let componentReference: string | undefined;
  if (command === "inspect") {
    const end = commandArgs.indexOf("--");
    const index = commandArgs.findIndex((argument, i) => (end < 0 || i < end) && (argument === "--summary" || argument === "--component"));
    if (index >= 0) {
      if (commandArgs[index] === "--summary") {
        summary = true;
        commandArgs.splice(index, 1);
      } else {
        componentReference = commandArgs[index + 1];
        if (!componentReference || componentReference.startsWith("--")) {
          console.error("inspect --component requires a component reference.");
          return 2;
        }
        commandArgs.splice(index, 2);
      }
    }
  }
  const parsed = parseCommandArguments(command, commandArgs);
  if (command === "theme") return runThemeCommand(args.slice(1));
  if (command === "component") return runComponentCommand(args.slice(1));
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
    const result = await installDashBoredSkill(project, { global: parsed.global, check });
    console.log(
      result.created.length === 0 && result.updated.length === 0 && result.linked.length === 0
        ? `dash-bored skill is already installed${parsed.global ? " globally" : ""} in ${result.skillPath}`
        : `Installed portable dash-bored skill${parsed.global ? " globally" : ""} in ${result.skillPath}`,
    );
    console.log(`Claude Code compatibility path: ${result.claudeSkillPath}`);
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
    const catalog = result.componentCatalog;
    const selected = componentReference ? catalog.find((item) => item.reference === componentReference) : undefined;
    if (componentReference && !selected) {
      console.error(`Component not found in project catalog: ${componentReference}`);
      return 1;
    }
    const output = summary ? {
      ok: result.ok, projectRoot: result.projectRoot, permissions: result.permissions, diagnostics: result.diagnostics,
      componentCatalog: catalog.map(({ reference, available, manifest }) => ({ reference, available,
        name: manifest?.name, description: manifest?.description, permissions: manifest?.permissions })),
    } : componentReference ? { ok: result.ok, diagnostics: result.diagnostics, component: selected } : result;
    console.log(JSON.stringify(output, null, process.stdout.isTTY ? 2 : 0));
    return result.ok ? 0 : 1;
  }

  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
