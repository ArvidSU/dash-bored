import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateComponentReference } from "../../scripts/generate-component-reference";

describe("generated built-in component reference", () => {
  test("matches the committed file byte-for-byte", async () => {
    const committed = await readFile(
      resolve(import.meta.dirname, "../../skills/dash-bored/references/builtins.md"),
      "utf8",
    );

    // If this fails, the committed reference drifted from BUILTIN_COMPONENTS:
    // run `bun run generate:components` and commit the regenerated file.
    expect(generateComponentReference()).toBe(committed);
    expect(committed).toContain("GENERATED FILE");
    expect(committed).toContain("bun run generate:components");
  });

  test("ends with a trailing newline and renders every manifest entry", async () => {
    const { listBuiltinManifests } = await import("../../src/core/builtins");
    const reference = generateComponentReference();

    expect(reference.endsWith("\n")).toBe(true);
    for (const manifest of listBuiltinManifests()) {
      expect(reference).toContain(`## ${manifest.id}`);
    }
  });
});
