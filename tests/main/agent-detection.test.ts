import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpCommandHint, agentDisplay, detectAgents, knownAgentForCommand } from "../../src/main/agent-detection";
import { HANDOFF_SESSION_ID, handoffScript, resumeCommand, shellWord } from "../../src/main/agent-handoff";
import { KNOWN_AGENTS } from "../../src/shared/agent-catalog";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function bin(names: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dash-bored-agents-"));
  cleanup.push(directory);
  await mkdir(directory, { recursive: true });
  for (const name of names) {
    await writeFile(join(directory, name), "#!/bin/sh\n");
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

test("detects known agents by their launch executable on PATH, in catalog order", async () => {
  // `codex` is Codex's own CLI, not its ACP adapter, so Codex is not detected from it.
  const path = await bin(["gemini", "codex", "codex-acp", "claude"]);
  expect(detectAgents({ PATH: path })).toEqual([
    { id: "codex", name: "Codex", command: "codex-acp", resumable: true },
    { id: "gemini", name: "Gemini CLI", command: "gemini --acp", resumable: true },
  ]);
  expect(detectAgents({ PATH: await bin([]) })).toEqual([]);
  expect(detectAgents({})).toEqual([]);
});

test("every catalog entry is data the app can use", () => {
  const ids = new Set<string>();
  for (const agent of KNOWN_AGENTS) {
    expect(ids.has(agent.id)).toBeFalse();
    ids.add(agent.id);
    expect(agent.command.trim()).toBe(agent.command);
    expect(agent.homepage).toStartWith("https://");
    if (agent.resume) expect(agent.resume).toContain("{sessionId}");
  }
});

test("matches launch commands to known agents and names others by their executable", () => {
  expect(knownAgentForCommand("codex-acp")?.id).toBe("codex");
  expect(knownAgentForCommand("/opt/homebrew/bin/gemini --acp --debug")?.id).toBe("gemini");
  expect(knownAgentForCommand("opencode acp")?.id).toBe("opencode");
  expect(knownAgentForCommand("gemini -p")).toBeUndefined();
  expect(knownAgentForCommand("npx @zed-industries/codex-acp")).toBeUndefined();
  expect(agentDisplay("goose acp")).toEqual({ name: "Goose", knownId: "goose" });
  expect(agentDisplay("/usr/local/bin/my-agent --stdio")).toEqual({ name: "my-agent" });
});

test("hints at the ACP command when a known agent's own CLI is configured", () => {
  expect(acpCommandHint("codex exec")).toContain("codex-acp");
  expect(acpCommandHint("codex exec --approve-for-me")).toContain("Codex");
  expect(acpCommandHint("claude -p")).toContain("claude-agent-acp");
  expect(acpCommandHint("gemini -p")).toContain("gemini --acp");
  expect(acpCommandHint("gemini --acp")).toBeUndefined();
  expect(acpCommandHint("cat")).toBeUndefined();
});

test("resume commands substitute the session id and project root as single shell words", () => {
  const codex = KNOWN_AGENTS.find((agent) => agent.id === "codex");
  expect(resumeCommand(codex, "019a-b.c:d_e", "/work/it's here")).toBe("codex resume -C '/work/it'\\''s here' '019a-b.c:d_e'");
  expect(resumeCommand(codex, null, "/work")).toBeNull();
  expect(resumeCommand(codex, "a-b", "/work")).toBe("codex resume -C '/work' 'a-b'");
  expect(resumeCommand({}, "abc", "/work")).toBeNull();
  for (const unsafe of ["", "a b", "x;rm -rf ~", "$(id)", "a'b", "-c", "--help", "x".repeat(201)]) {
    expect(HANDOFF_SESSION_ID.test(unsafe)).toBeFalse();
    expect(resumeCommand(codex, unsafe, "/work")).toBeNull();
  }
  expect(shellWord("a'b")).toBe("'a'\\''b'");
  expect(handoffScript("/work/it's", "claude --resume 'abc'")).toBe("#!/bin/sh\ncd '/work/it'\\''s' || exit 1\nexec claude --resume 'abc'\n");
});
