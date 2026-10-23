import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateComponentReference, renderDeprecation } from "../../scripts/generate-component-reference";
import type { ComponentManifest } from "../../src/shared/contracts";

describe("generated core component reference", () => {
  test("renders deprecation metadata for component IDs outside the core namespace", () => {
    const manifest = {
      schemaVersion: 3,
      apiVersion: "2.0.0",
      id: "vendor/unrelated-widget",
      name: "Unrelated widget",
      description: "A third-party widget.",
      entry: "./index.tsx",
      propsSchema: { type: "object" },
      deprecated: { replacement: "./components/vendor/new-widget" },
    } satisfies ComponentManifest;
    expect(renderDeprecation(manifest)).toEqual([
      "**Retiring** — kept for older dashboards; replacement: ./components/vendor/new-widget.",
      "",
    ]);
  });

  test("renders every pinned deprecation from its manifest metadata", async () => {
    const { coreManifests, coreReference } = await import("../../scripts/core-package-fixture");
    const reference = generateComponentReference();
    const sectionOf = (name: string) =>
      reference.slice(reference.indexOf(`## ${coreReference(name)}\n`)).split("\n## ")[0]!;
    const deprecated = coreManifests.filter((manifest) => manifest.deprecated !== undefined);
    expect(deprecated.length).toBeGreaterThan(0);
    for (const manifest of coreManifests) {
      const section = sectionOf(manifest.id);
      if (manifest.deprecated) {
        expect(section).toContain(`**Retiring** — kept for older dashboards; replacement: ${manifest.deprecated.replacement}.`);
      } else {
        expect(section).not.toContain("**Retiring**");
      }
    }
  });

  test("shipped guidance references only catalog components or the authoring API", async () => {
    const { coreManifests, coreReference } = await import("../../scripts/core-package-fixture");
    const known = new Set(["@dash-bored/component", ...coreManifests.map((manifest) => coreReference(manifest.id))]);
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

    // If this fails, the committed reference drifted from the pinned manifests:
    // run `bun run generate:components` and commit the regenerated file.
    expect(generateComponentReference()).toBe(committed);
    expect(committed).toContain("GENERATED FILE");
    expect(committed).toContain("bun run generate:components");
  });

  test("ends with a trailing newline and renders every manifest entry", async () => {
    const { coreManifests, coreReference } = await import("../../scripts/core-package-fixture");
    const reference = generateComponentReference();

    expect(reference.endsWith("\n")).toBe(true);
    for (const manifest of coreManifests) {
      expect(reference).toContain(`## ${coreReference(manifest.id)}`);
    }
  });
});
