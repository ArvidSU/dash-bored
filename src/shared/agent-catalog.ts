import type { KnownAgent } from "./agent-session";

/**
 * Known Agent Client Protocol agents, in picker order. This is data: the app
 * matches `command`'s executable on PATH and fills `resume` for hand-off, and
 * never branches on an agent's id. Launch commands follow the ACP registry
 * (github.com/agentclientprotocol/registry); resume commands were checked
 * against each agent's source: the ACP session id is the agent's own id.
 * Claude and Codex speak ACP through adapters. Package runners are configured
 * only for agents the user explicitly enables in Settings.
 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude-agent-acp",
    cli: "claude",
    resume: "claude --resume {sessionId}",
    package: "@agentclientprotocol/claude-agent-acp",
    homepage: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    cli: "codex",
    resume: "codex resume -C {cwd} {sessionId}",
    package: "@agentclientprotocol/codex-acp",
    homepage: "https://github.com/agentclientprotocol/codex-acp",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini --acp",
    cli: "gemini",
    resume: "gemini --resume {sessionId}",
    package: "@google/gemini-cli",
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: "copilot --acp",
    cli: "copilot",
    resume: "copilot --resume {sessionId}",
    package: "@github/copilot",
    homepage: "https://github.com/github/copilot-cli",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode acp",
    cli: "opencode",
    package: "opencode-ai",
    resume: "opencode {cwd} --session {sessionId}",
    homepage: "https://opencode.ai",
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose acp",
    cli: "goose",
    resume: "goose session --resume --session-id {sessionId}",
    homepage: "https://block.github.io/goose/",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    command: "qwen --acp",
    cli: "qwen",
    resume: "qwen --resume {sessionId}",
    package: "@qwen-code/qwen-code",
    homepage: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    command: "kimi acp",
    cli: "kimi",
    resume: "kimi -w {cwd} --session {sessionId}",
    homepage: "https://github.com/MoonshotAI/kimi-cli",
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    command: "vibe-acp",
    cli: "vibe",
    resume: "vibe --resume {sessionId}",
    homepage: "https://github.com/mistralai/mistral-vibe",
  },
  {
    id: "cline",
    name: "Cline",
    command: "cline --acp",
    cli: "cline",
    resume: "cline --id {sessionId}",
    package: "cline",
    homepage: "https://cline.bot",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    command: "cursor-agent acp",
    cli: "cursor-agent",
    resume: "cursor-agent --resume {sessionId}",
    homepage: "https://cursor.com/cli",
  },
];
