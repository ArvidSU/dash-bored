import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateComponentReference } from "../../scripts/generate-component-reference";
import { CORE_REFERENCE_PREFIX } from "../../src/shared/core-package";
import { RETIRING_CORE_COMPONENTS } from "../../src/shared/retiring-components";

describe("generated built-in component reference", () => {
  test("marks every retiring core component under its heading and no other", async () => {
    const { coreManifests, coreReference } = await import("../../scripts/core-package-fixture");
    const shipped = new Set(coreManifests.map((manifest) => coreReference(manifest.id)));
    for (const name of Object.keys(RETIRING_CORE_COMPONENTS)) {
      expect(shipped.has(`${CORE_REFERENCE_PREFIX}${name}`)).toBeTrue();
    }

    const reference = generateComponentReference();
    const sectionOf = (name: string) =>
      reference.slice(reference.indexOf(`## ${CORE_REFERENCE_PREFIX}${name}\n`)).split("\n## ")[0]!;
    expect(sectionOf("card")).toContain("**Retiring** — kept for older dashboards; replacement: a titled `group`.");
    expect(sectionOf("tabs")).toContain("replacement: a `selection` with a `variant: tabs` button.");
    expect(sectionOf("list")).not.toContain("**Retiring**");
    expect(sectionOf("group")).not.toContain("**Retiring**");
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

    // If this fails, the committed reference drifted from BUILTIN_COMPONENTS:
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
