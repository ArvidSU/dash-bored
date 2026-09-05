import { CoreError } from "../core/diagnostics";

const SHELL_BUILTINS = new Set([
  "alias", "bg", "break", "builtin", "cd", "command", "continue", "echo", "eval", "exec",
  "exit", "export", "fg", "getopts", "hash", "jobs", "kill", "read", "readonly", "return",
  "set", "shift", "source", "test", "times", "trap", "type", "ulimit", "umask", "unalias", "unset", "wait",
]);

function firstToken(command: string): { token: string; dynamic: boolean; compound: boolean } | null {
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let dynamic = false;
  let compound = false;
  let started = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === "\\") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else { token += char; started = true; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "$" || char === "`") { dynamic = true; token += char; started = true; continue; }
    if ("|;&<>()".includes(char)) { compound = true; continue; }
    if (/\s/.test(char)) {
      if (started) break;
      continue;
    }
    token += char;
    started = true;
  }
  if (!token) return null;
  return { token, dynamic, compound: compound || quote !== null || escaped };
}

/** Verify a simple configured executable without trying to interpret shell syntax. */
export function assertAgentAvailable(command: string, env: Record<string, string> = process.env as Record<string, string>, cwd = process.cwd()): void {
  // A configured shell expression may provide its own fallback or expansion.
  // Keep this advisory check conservative rather than executing that expression.
  if (/[|;&<>()$`\n]/.test(command)) return;
  const parsed = firstToken(command);
  if (!parsed || parsed.dynamic || parsed.compound || parsed.token.includes("=")) return;
  if (["sh", "bash", "zsh", "fish", "cmd", "cmd.exe"].includes(parsed.token) && /\s(?:-c|\/c)(?:\s|$)/.test(command)) return;
  if (SHELL_BUILTINS.has(parsed.token)) return;
  if (!Bun.which(parsed.token, { PATH: env.PATH, cwd })) {
    throw new CoreError(
      "DASHBOARD_AGENT_UNAVAILABLE",
      `Configured dashboard agent executable “${parsed.token}” was not found. Choose an available command in Settings → General → Dashboard agent.`,
    );
  }
}
