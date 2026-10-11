import { expect, test } from "bun:test";
import { agentSetup } from "../../src/shared/agent-setup";
import { KNOWN_AGENTS } from "../../src/shared/agent-catalog";

const installed = [{ id: "codex", name: "Codex", command: "codex-acp", resumable: true }];

test("legacy discovery never opts missing packages into download; explicit empty enablement disables every choice", () => {
  expect(agentSetup(KNOWN_AGENTS, installed, undefined, "npx").detected).toEqual(installed);
  expect(agentSetup(KNOWN_AGENTS, installed, [], "npx").detected).toEqual([]);
});

test("explicit enablement prefers installed commands and configures package downloads with ACP arguments", () => {
  const result = agentSetup(KNOWN_AGENTS, installed, ["codex", "gemini", "opencode", "goose", "unknown"], "npx");
  expect(result.detected.map((agent) => agent.command)).toEqual([
    "codex-acp", "npx -y @google/gemini-cli --acp", "npx -y opencode-ai acp",
  ]);
  expect(result.setup.find((agent) => agent.id === "goose")).toMatchObject({ enabled: true, installed: false, command: null });
  expect(result.setup.find((agent) => agent.id === "codex")).toMatchObject({ installed: true });
});

test("missing runners remain visible but unavailable; Bun is an alternative package runner", () => {
  expect(agentSetup(KNOWN_AGENTS, [], ["codex"], null).detected).toEqual([]);
  expect(agentSetup(KNOWN_AGENTS, [], ["codex"], null).setup.find((agent) => agent.id === "codex")?.needs).toContain("Node.js");
  expect(agentSetup(KNOWN_AGENTS, [], ["codex"], "bunx").detected[0]?.command).toBe("bunx @agentclientprotocol/codex-acp");
});
