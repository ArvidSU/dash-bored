import { CoreError } from "../core/diagnostics";

const SHELL_BUILTINS = new Set([
  ".", ":", "alias", "bg", "break", "builtin", "cd", "command", "continue", "echo", "eval", "exec",
  "exit", "export", "fg", "getopts", "hash", "jobs", "kill", "read", "readonly", "return",
  "set", "shift", "source", "test", "times", "trap", "type", "ulimit", "umask", "unalias", "unset", "wait",
]);
const SHELL_KEYWORDS = new Set([
  "!", "{", "}", "[[", "]]", "case", "do", "done", "elif", "else", "esac", "fi", "for", "function",
  "if", "in", "local", "select", "then", "time", "until", "while",
]);

/** The literal first word of a shell command, without interpreting it. */
export function firstToken(command: string): { token: string; dynamic: boolean; compound: boolean } | null {
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

/**
 * A plain invocation the shell can `exec`: the first word is a literal
 * executable (no assignment, builtin, keyword, or expansion) and the command
 * has no operators, redirections, or subshells. Anything else is run as is.
 */
export function isSimpleInvocation(command: string): boolean {
  if (/[|;&<>()`\n]/.test(command)) return false;
  const parsed = firstToken(command);
  return parsed !== null && !parsed.dynamic && !parsed.compound && !parsed.token.includes("=")
    && !SHELL_BUILTINS.has(parsed.token) && !SHELL_KEYWORDS.has(parsed.token);
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
      `Agent executable “${parsed.token}” was not found on PATH. Install it, or choose another agent (or an absolute command) in Settings → General → Dashboard agent.`,
    );
  }
}
