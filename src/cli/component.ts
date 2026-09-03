import {
  addComponent,
  listComponents,
  removeComponent,
  statusComponents,
  syncComponents,
  updateComponent,
  type ExternalComponentStatus,
} from "../core/external-components";
import { CoreError, errorMessage } from "../core/diagnostics";

const SUBCOMMANDS = ["add", "list", "status", "update", "remove", "sync"] as const;

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

function failed(subcommand: ComponentSubcommand | null, error: string): ParsedComponentArguments {
  return {
    subcommand,
    url: null,
    name: null,
    ref: null,
    to: null,
    project: ".",
    help: false,
    error,
  };
}

function isProjectPath(value: string): boolean {
  return value.startsWith(".") || value.includes("/") || value.includes("\\");
}

function takeOptionValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } | { error: string } {
  const value = args[index + 1];
  if (value === undefined || value === "--" || value.startsWith("-")) {
    return { error: `Option ${flag} requires a value.` };
  }
  return { value, nextIndex: index + 1 };
}

export function componentUsage(): string {
  return `dash-bored component <command>

Commands:
  dash-bored component add <url> [--name <name>] [--ref <ref>] [project]
  dash-bored component list [project]
  dash-bored component status [<name>] [project]
  dash-bored component update <name> [--to <ref>] [project]
  dash-bored component remove <name> [project]
  dash-bored component sync [project]

Manage external components: git submodules below components/external/ pinned
in dash-bored-lock.yaml. <url> is a git clone URL; --ref pins a branch, tag,
or commit (default: the remote HEAD). status with one bare argument shows that
component; pass a path (./proj, ../proj, /abs, a/b) to target a project.`;
}

export function parseComponentArguments(args: string[]): ParsedComponentArguments {
  const [subcommand, ...rest] = args;
  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === "help"
  ) {
    return {
      subcommand: null,
      url: null,
      name: null,
      ref: null,
      to: null,
      project: ".",
      help: true,
      error: null,
    };
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return failed(null, `Unknown component command: ${subcommand}\n\n${componentUsage()}`);
  }
  const command = subcommand as ComponentSubcommand;

  let name: string | null = null;
  let ref: string | null = null;
  let to: string | null = null;
  let nameSpecified = false;
  let refSpecified = false;
  let toSpecified = false;
  const positional: string[] = [];
  let optionsEnabled = true;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === "--help" || argument === "-h")) {
      return {
        subcommand: command,
        url: null,
        name: null,
        ref: null,
        to: null,
        project: ".",
        help: true,
        error: null,
      };
    }
    if (optionsEnabled && (argument === "--name" || argument.startsWith("--name="))) {
      if (command !== "add") return failed(command, `component ${command} does not accept --name.`);
      if (nameSpecified) return failed(command, "Option --name may be specified only once.");
      if (argument.startsWith("--name=")) {
        name = argument.slice("--name=".length);
        if (name === "") return failed(command, "Option --name requires a value.");
      } else {
        const taken = takeOptionValue(rest, index, "--name");
        if ("error" in taken) return failed(command, taken.error);
        name = taken.value;
        index = taken.nextIndex;
      }
      nameSpecified = true;
      continue;
    }
    if (optionsEnabled && (argument === "--ref" || argument.startsWith("--ref="))) {
      if (command !== "add") return failed(command, `component ${command} does not accept --ref.`);
      if (refSpecified) return failed(command, "Option --ref may be specified only once.");
      if (argument.startsWith("--ref=")) {
        ref = argument.slice("--ref=".length);
        if (ref === "") return failed(command, "Option --ref requires a value.");
      } else {
        const taken = takeOptionValue(rest, index, "--ref");
        if ("error" in taken) return failed(command, taken.error);
        ref = taken.value;
        index = taken.nextIndex;
      }
      refSpecified = true;
      continue;
    }
    if (optionsEnabled && (argument === "--to" || argument.startsWith("--to="))) {
      if (command !== "update") return failed(command, `component ${command} does not accept --to.`);
      if (toSpecified) return failed(command, "Option --to may be specified only once.");
      if (argument.startsWith("--to=")) {
        to = argument.slice("--to=".length);
        if (to === "") return failed(command, "Option --to requires a value.");
      } else {
        const taken = takeOptionValue(rest, index, "--to");
        if ("error" in taken) return failed(command, taken.error);
        to = taken.value;
        index = taken.nextIndex;
      }
      toSpecified = true;
      continue;
    }
    if (optionsEnabled && argument.startsWith("-")) {
      return failed(command, `Unknown option for component ${command}: ${argument}`);
    }
    positional.push(argument);
  }

  // A bare name collides with a bare project directory: treat values that look
  // like paths (./proj, ../proj, /abs, a/b) as the project, anything else as
  // the component name. Prefix with ./ to force a project interpretation.
  const splitNameAndProject = (values: string[]): { name: string | null; project: string } => {
    if (values.length === 0) return { name: null, project: "." };
    if (values.length === 2) return { name: values[0]!, project: values[1]! };
    const [only] = values;
    return isProjectPath(only!) ? { name: null, project: only! } : { name: only!, project: "." };
  };

  switch (command) {
    case "add": {
      if (positional.length < 1) return failed(command, "component add requires a repository URL.");
      if (positional.length > 2) {
        return failed(command, "component add accepts a URL and at most one project path.");
      }
      return {
        subcommand: command,
        url: positional[0]!,
        name,
        ref,
        to: null,
        project: positional[1] ?? ".",
        help: false,
        error: null,
      };
    }
    case "list": {
      if (positional.length > 1) {
        return failed(command, "component list accepts at most one project path.");
      }
      return {
        subcommand: command,
        url: null,
        name: null,
        ref: null,
        to: null,
        project: positional[0] ?? ".",
        help: false,
        error: null,
      };
    }
    case "status": {
      if (positional.length > 2) {
        return failed(command, "component status accepts at most a component name and a project path.");
      }
      const split = splitNameAndProject(positional);
      return {
        subcommand: command,
        url: null,
        name: split.name,
        ref: null,
        to: null,
        project: split.project,
        help: false,
        error: null,
      };
    }
    case "update": {
      if (positional.length < 1) return failed(command, "component update requires a component name.");
      if (positional.length > 2) {
        return failed(command, "component update accepts a name and at most one project path.");
      }
      return {
        subcommand: command,
        url: null,
        name: positional[0]!,
        ref: null,
        to,
        project: positional[1] ?? ".",
        help: false,
        error: null,
      };
    }
    case "remove": {
      if (positional.length < 1) return failed(command, "component remove requires a component name.");
      if (positional.length > 2) {
        return failed(command, "component remove accepts a name and at most one project path.");
      }
      return {
        subcommand: command,
        url: null,
        name: positional[0]!,
        ref: null,
        to: null,
        project: positional[1] ?? ".",
        help: false,
        error: null,
      };
    }
    case "sync": {
      if (positional.length > 1) {
        return failed(command, "component sync accepts at most one project path.");
      }
      return {
        subcommand: command,
        url: null,
        name: null,
        ref: null,
        to: null,
        project: positional[0] ?? ".",
        help: false,
        error: null,
      };
    }
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
    console.error(error instanceof CoreError || error instanceof Error ? error.message : errorMessage(error));
    return 1;
  }
}
