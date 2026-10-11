import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "../core/diagnostics";
import type { KnownAgent } from "../shared/agent-session";

/**
 * ACP session ids that may be substituted into a resume command. A leading
 * `-` is refused so an id can never be read as an option of the agent's CLI.
 */
export const HANDOFF_SESSION_ID = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,199}$/;

/** One single-quoted POSIX shell word. */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The agent's native resume command for one session, run from the project
 * root, or null when the agent defines none or the id is not safe to pass.
 */
export function resumeCommand(agent: Pick<KnownAgent, "resume"> | undefined, sessionId: string | null, cwd: string): string | null {
  if (!agent?.resume || sessionId === null || !HANDOFF_SESSION_ID.test(sessionId)) return null;
  return agent.resume.replaceAll("{sessionId}", shellWord(sessionId)).replaceAll("{cwd}", shellWord(cwd));
}

/** A double-clickable script: the user's default terminal app runs it, no Automation permission needed. */
export function handoffScript(projectRoot: string, resume: string): string {
  return `#!/bin/sh\ncd ${shellWord(projectRoot)} || exit 1\nexec ${resume}\n`;
}

export async function writeHandoffScript(directory: string, taskId: string, contents: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.command`);
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

/** Opens a `.command` script in the user's default terminal app (macOS). */
export async function openHandoffScript(path: string): Promise<void> {
  const opener = Bun.spawn({ cmd: ["/usr/bin/open", path], stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([opener.exited, new Response(opener.stderr).text()]);
  if (code !== 0) {
    throw new CoreError("AGENT_HANDOFF_FAILED", stderr.trim() || `open exited with code ${code}.`);
  }
}
