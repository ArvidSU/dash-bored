import { basename } from "node:path";
import { KNOWN_AGENTS } from "../shared/agent-catalog";
import type { DetectedAgent, KnownAgent } from "../shared/agent-session";
import { firstToken } from "./agent-preflight";

/*
 * Matching commands against the known-agent table. Everything here is data
 * driven: no code path branches on a particular agent.
 */

function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function executable(command: string): string | null {
  const token = firstToken(command)?.token;
  return token ? basename(token) : null;
}

/**
 * Known agents whose launch executable is on `PATH`, in catalog order. The
 * PATH is the app's normalized one (see `configureDesktopExecutableEnvironment`);
 * no shell startup files are read.
 */
export function detectAgents(
  env: Readonly<Record<string, string | undefined>> = process.env,
  catalog: readonly KnownAgent[] = KNOWN_AGENTS,
): DetectedAgent[] {
  return catalog
    .filter((agent) => {
      const program = words(agent.command)[0];
      return program !== undefined && Bun.which(program, { PATH: env.PATH ?? "" }) !== null;
    })
    .map((agent) => ({ id: agent.id, name: agent.name, command: agent.command, resumable: agent.resume !== undefined }));
}

/**
 * The known agent a launch command runs: its executable matches the agent's
 * launch executable and it carries the launch command's remaining words
 * (such as `--acp`), so `/opt/homebrew/bin/gemini --acp --debug` is Gemini CLI.
 */
const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);

/** `@scope/name@1.2.3` → `@scope/name`; `name@latest` → `name`. */
function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export function knownAgentForCommand(command: string, catalog: readonly KnownAgent[] = KNOWN_AGENTS): KnownAgent | undefined {
  const program = executable(command);
  if (!program) return undefined;
  const given = new Set(words(command).slice(1));
  // `npx [-y] <package>[@version] [args]` runs a known agent's published package.
  const spec = PACKAGE_RUNNERS.has(program) ? words(command).slice(1).find((word) => !word.startsWith("-")) : undefined;
  return catalog.find((agent) => {
    const [launch, ...rest] = words(agent.command);
    const launches = launch === program || (spec !== undefined && agent.package === packageName(spec));
    return launches && rest.every((word) => given.has(word));
  });
}

export function agentDisplay(command: string): { name: string; knownId?: string } {
  const known = knownAgentForCommand(command);
  return known ? { name: known.name, knownId: known.id } : { name: executable(command) ?? command.trim() };
}

/**
 * A hint for a command that runs an agent's own CLI instead of its ACP
 * command, such as the old `codex exec` or `claude -p` settings.
 */
export function acpCommandHint(command: string, catalog: readonly KnownAgent[] = KNOWN_AGENTS): string | undefined {
  if (knownAgentForCommand(command, catalog)) return undefined;
  const program = executable(command);
  const agent = catalog.find((candidate) => candidate.cli === program || words(candidate.command)[0] === program);
  if (!agent) return undefined;
  return `“${program}” is ${agent.name}'s own CLI. dash-bored needs its ACP command: ${agent.command}${
    words(agent.command)[0] === program ? "" : ` (install it from ${agent.homepage})`}.`;
}
