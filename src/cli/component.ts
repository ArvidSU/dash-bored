import { restoreMissingPackages } from "../core/package-restore";
import { migratePackageOwnership } from "../core/package-ownership";
import {
  addComponent,
  listComponents,
  removeComponent,
  statusComponents,
  syncComponents,
  updateComponent,
  type ExternalComponentStatus,
} from "../core/external-components";
import { errorMessage } from "../core/diagnostics";
import { COMPONENT_AUTHORING_LINES, runComponentAuthoringCommand } from "./component-authoring";

const SUBCOMMANDS = ["add", "list", "status", "update", "remove", "sync", "restore", "migrate-ownership"] as const;

type ComponentSubcommand = (typeof SUBCOMMANDS)[number];

interface ParsedComponentArguments {
  subcommand: ComponentSubcommand | null;
  url: string | null;
  name: string | null;
  ref: string | null;
  to: string | null;
  project: string;
  help: boolean;
  error: string | null;
}

function parsed(
  subcommand: ComponentSubcommand | null,
  fields: Partial<ParsedComponentArguments>,
): ParsedComponentArguments {
  return { subcommand, url: null, name: null, ref: null, to: null, project: ".", help: false, error: null, ...fields };
}

const failed = (subcommand: ComponentSubcommand | null, error: string) => parsed(subcommand, { error });

/** Value options and the one subcommand that accepts each. */
const VALUE_OPTIONS = { name: "add", ref: "add", to: "update" } as const;

function isProjectPath(value: string): boolean {
  return value.startsWith(".") || value.includes("/") || value.includes("\\");
}

export const COMPONENT_COMMAND_LINES = `${COMPONENT_AUTHORING_LINES}
  dash-bored component add <url> [--name <name>] [--ref <ref>] [project]
  dash-bored component list [project]
  dash-bored component status [<name>] [project]
  dash-bored component update <name> [--to <ref>] [project]
  dash-bored component remove <name> [project]
  dash-bored component sync [project]
  dash-bored component restore [project]
  dash-bored component migrate-ownership [project]`;

export function componentUsage(): string {
  return `dash-bored component <command>

Commands:
${COMPONENT_COMMAND_LINES}

Manage external components: dash-bored-owned submodules below components/external/ pinned
in dash-bored-lock.yaml. <url> is a git clone URL; --ref pins a branch, tag,
or commit (default: the remote HEAD). status with one bare argument shows that
component; pass a path (./proj, ../proj, /abs, a/b) to target a project.`;
}

export function parseComponentArguments(args: string[]): ParsedComponentArguments {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    return parsed(null, { help: true });
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return failed(null, `Unknown component command: ${subcommand}\n\n${componentUsage()}`);
  }
  const command = subcommand as ComponentSubcommand;

  const values: Partial<Record<keyof typeof VALUE_OPTIONS, string>> = {};
  const positional: string[] = [];
  let optionsEnabled = true;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === "--help" || argument === "-h")) return parsed(command, { help: true });
    const option = optionsEnabled
      ? (Object.keys(VALUE_OPTIONS) as (keyof typeof VALUE_OPTIONS)[]).find(
          (key) => argument === `--${key}` || argument.startsWith(`--${key}=`),
        )
      : undefined;
    if (option) {
      const flag = `--${option}`;
      if (command !== VALUE_OPTIONS[option]) return failed(command, `component ${command} does not accept ${flag}.`);
      if (values[option] !== undefined) return failed(command, `Option ${flag} may be specified only once.`);
      const value = argument === flag ? rest[++index] : argument.slice(flag.length + 1);
      if (!value || (argument === flag && value.startsWith("-"))) return failed(command, `Option ${flag} requires a value.`);
      values[option] = value;
      continue;
    }
    if (optionsEnabled && argument.startsWith("-")) {
      return failed(command, `Unknown option for component ${command}: ${argument}`);
    }
    positional.push(argument);
  }

  switch (command) {
    case "add":
      if (positional.length < 1) return failed(command, "component add requires a repository URL.");
      if (positional.length > 2) return failed(command, "component add accepts a URL and at most one project path.");
      return parsed(command, {
        url: positional[0]!,
        name: values.name ?? null,
        ref: values.ref ?? null,
        project: positional[1] ?? ".",
      });
    case "status": {
      if (positional.length > 2) {
        return failed(command, "component status accepts at most a component name and a project path.");
      }
      // A bare name collides with a bare project directory: treat values that look
      // like paths (./proj, ../proj, /abs, a/b) as the project, anything else as
      // the component name. Prefix with ./ to force a project interpretation.
      const [first, second] = positional;
      if (second !== undefined) return parsed(command, { name: first!, project: second });
      if (first === undefined) return parsed(command, {});
      return parsed(command, isProjectPath(first) ? { project: first } : { name: first });
    }
    case "update":
    case "remove":
      if (positional.length < 1) return failed(command, `component ${command} requires a component name.`);
      if (positional.length > 2) {
        return failed(command, `component ${command} accepts a name and at most one project path.`);
      }
      return parsed(command, { name: positional[0]!, to: values.to ?? null, project: positional[1] ?? "." });
    case "list":
    case "restore":
    case "migrate-ownership":
    case "sync":
      if (positional.length > 1) {
        return failed(command, `component ${command === "list" ? "list" : "sync"} accepts at most one project path.`);
      }
      return parsed(command, { project: positional[0] ?? "." });
  }
}

function printStatus(status: ExternalComponentStatus): void {
  console.log(status.name);
  console.log(`  url: ${status.url}`);
  console.log(`  pinned: ${status.commit}`);
  console.log(
    status.initialized && status.checkedOutCommit !== null
      ? `  checked out: ${status.checkedOutCommit}`
      : "  checked out: uninitialized (run `dash-bored component sync`)",
  );
  if (status.initialized) {
    console.log(`  dirty: ${status.dirty ? "yes" : "no"}`);
    console.log(`  in sync: ${status.inSync ? "yes" : "no"}`);
  }
  console.log(
    `  update available: ${status.updateAvailable === null ? "unknown" : status.updateAvailable ? "yes" : "no"}`,
  );
}

export async function runComponentCommand(args: string[]): Promise<number> {
  const authoringResult = await runComponentAuthoringCommand(args);
  if (authoringResult !== null) return authoringResult;
  const parsed = parseComponentArguments(args);
  if (parsed.help) {
    console.log(componentUsage());
    return 0;
  }
  if (parsed.error || parsed.subcommand === null) {
    console.error(`${parsed.error ?? componentUsage()}\n`);
    console.error(componentUsage());
    return 2;
  }
  try {
    switch (parsed.subcommand) {
      case "add": {
        const result = await addComponent(parsed.project, parsed.url!, {
          ...(parsed.name === null ? {} : { name: parsed.name }),
          ...(parsed.ref === null ? {} : { ref: parsed.ref }),
        });
        console.log(`Added external component ${result.name} at ${result.commit}.`);
        return 0;
      }
      case "list": {
        const entries = await listComponents(parsed.project);
        if (entries.length === 0) {
          console.log("No external components pinned.");
          return 0;
        }
        for (const entry of entries) console.log(`${entry.name} ${entry.commit} ${entry.url}`);
        return 0;
      }
      case "status": {
        const statuses = await statusComponents(
          parsed.project,
          parsed.name === null ? undefined : parsed.name,
        );
        if (statuses.length === 0) {
          console.log("No external components pinned.");
          return 0;
        }
        for (const status of statuses) printStatus(status);
        return 0;
      }
      case "update": {
        const result = await updateComponent(parsed.project, parsed.name!, {
          ...(parsed.to === null ? {} : { to: parsed.to }),
        });
        console.log(
          result.changed
            ? `Updated ${result.name} to ${result.commit}.`
            : `${result.name} is already at ${result.commit}.`,
        );
        return 0;
      }
      case "remove": {
        const result = await removeComponent(parsed.project, parsed.name!);
        console.log(`Removed external component ${result.name}.`);
        return 0;
      }
      case "migrate-ownership": console.log(JSON.stringify(await migratePackageOwnership(parsed.project))); return 0;
      case "restore": {
        const diagnostics = await restoreMissingPackages(parsed.project);
        if (diagnostics.length) throw new Error(diagnostics.map(item=>item.message).join("; "));
        console.log("Missing pinned packages restored."); return 0;
      }
      case "sync": {
        const synced = await syncComponents(parsed.project);
        if (synced.length === 0) {
          console.log("No external components pinned.");
          return 0;
        }
        for (const entry of synced) console.log(`Synced ${entry.name} to ${entry.commit}.`);
        return 0;
      }
    }
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}
