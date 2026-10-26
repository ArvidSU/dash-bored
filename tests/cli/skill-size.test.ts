import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// SKILL.md loads in full whenever the skill triggers, so keep it lean: move
// detail into references/ rather than raising this limit. Also runs as the
// pre-commit hook in .githooks/pre-commit.
const SKILL_CHARACTER_LIMIT = 20_000;

test("SKILL.md stays under the character limit", async () => {
  const skill = await readFile(resolve(import.meta.dirname, "../../skills/dash-bored/SKILL.md"), "utf8");
  expect([...skill].length).toBeLessThan(SKILL_CHARACTER_LIMIT);
});
