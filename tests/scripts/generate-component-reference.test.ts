import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateComponentReference } from "../../scripts/generate-component-reference";

describe("generated built-in component reference", () => {
  test("shipped guidance references only catalog components or the authoring API", async () => {
    const { listBuiltinManifests } = await import("../../src/core/builtins");
    const known = new Set(["@dash-bored/component", ...listBuiltinManifests().map((manifest) => manifest.id)]);
    const guidance = await Promise.all(["SKILL.md", "references/components.md", "references/builtins.md"].map((file) =>
      readFile(resolve(import.meta.dirname, "../../skills/dash-bored", file), "utf8"),
    ));
    for (const source of guidance) {
      for (const [reference] of source.matchAll(/@dash-bored\/[a-z][a-z0-9-]*/g)) {
        expect(known.has(reference)).toBeTrue();
      }
    }
  });

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
