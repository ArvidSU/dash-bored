import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentConfigMemory, MAX_REMEMBERED_AGENTS } from "../../src/main/agent-config-memory";
import type { AgentConfigOption } from "../../src/shared/agent-session";
import { removeTemporaryDirectory, temporaryDirectory } from "../core/helpers";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

async function memoryPath(): Promise<string> {
  const directory = await temporaryDirectory();
  cleanup.push(directory);
  return join(directory, "state", "agent-config.json");
}

const MODEL: AgentConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "fast",
  options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart", group: "Claude" }],
};
const FAST: AgentConfigOption = { id: "fast", name: "Fast mode", type: "boolean", currentValue: false };

test("remembers offered options and the last choices per command across app sessions", async () => {
  const path = await memoryPath();
  const memory = new AgentConfigMemory(path);
  expect(await memory.get()).toEqual({});
  await memory.offered("claude-agent-acp", [MODEL, FAST]);
  await memory.chose("claude-agent-acp", { model: "smart", fast: true });
  // A newer session refreshes the offer and keeps the choices.
  await memory.offered("claude-agent-acp", [MODEL]);
  await memory.chose("gemini --acp", { mode: "plan" });

  const reloaded = new AgentConfigMemory(path);
  expect(await reloaded.get()).toEqual({
    "claude-agent-acp": { options: [MODEL], chosen: { model: "smart", fast: true } },
    "gemini --acp": { options: [], chosen: { mode: "plan" } },
  });
  // New choices replace the old ones whole.
  await reloaded.chose("claude-agent-acp", {});
  expect((await new AgentConfigMemory(path).get())["claude-agent-acp"]).toEqual({ options: [MODEL], chosen: {} });
  expect((await readFile(path, "utf8")).startsWith('{\n  "version": 1,')).toBeTrue();
});

test("forgets the least recently used commands beyond the limit", async () => {
  const path = await memoryPath();
  const memory = new AgentConfigMemory(path);
  for (let index = 0; index < MAX_REMEMBERED_AGENTS; index += 1) await memory.offered(`agent-${index}`, [FAST]);
  // Using the oldest again keeps it; the next oldest goes instead.
  await memory.chose("agent-0", { fast: true });
  await memory.offered("agent-extra", [FAST]);
  const remembered = await new AgentConfigMemory(path).get();
  expect(Object.keys(remembered)).toHaveLength(MAX_REMEMBERED_AGENTS);
  expect(remembered["agent-0"]).toEqual({ options: [FAST], chosen: { fast: true } });
  expect(remembered["agent-1"]).toBeUndefined();
  expect(Object.keys(remembered).at(-1)).toBe("agent-extra");
});

test("an unreadable or malformed file starts empty and drops only malformed entries", async () => {
  const path = await memoryPath();
  await new AgentConfigMemory(path).offered("seed", [FAST]);
  await writeFile(path, "{ not json");
  expect(await new AgentConfigMemory(path).get()).toEqual({});
  await writeFile(path, JSON.stringify({ version: 2, agents: { a: { options: [], chosen: {}, usedAt: "x" } } }));
  expect(await new AgentConfigMemory(path).get()).toEqual({});
  await writeFile(path, JSON.stringify({
    version: 1,
    agents: {
      good: { options: [MODEL], chosen: { model: "smart" }, usedAt: "2026-10-14T00:00:00.000Z" },
      badOption: { options: [{ id: "model" }], chosen: {}, usedAt: "2026-10-14T00:00:00.000Z" },
      badChoice: { options: [], chosen: { model: 3 }, usedAt: "2026-10-14T00:00:00.000Z" },
      missing: { options: [] },
    },
  }));
  expect(await new AgentConfigMemory(path).get()).toEqual({ good: { options: [MODEL], chosen: { model: "smart" } } });
});
