import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  inspectProject,
  loadProjectDefinition,
  resolveProjectLocation,
} from "../../src/core";
import type { DashboardConfig } from "../../src/shared/contracts";
import {
  createProject,
  defaultConfig,
  removeTemporaryDirectory,
  temporaryDirectory,
  writeLocalComponent,
} from "./helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

describe("project paths and YAML", () => {
  test("resolves a root, config directory, and config file consistently", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);

    const fromRoot = await resolveProjectLocation(root);
    const fromDirectory = await resolveProjectLocation(join(root, "dash-bored"));
    const fromFile = await resolveProjectLocation(join(root, "dash-bored", "dash-bored.yaml"));

    expect(fromDirectory).toEqual(fromRoot);
    expect(fromFile).toEqual(fromRoot);
    expect(fromRoot.projectRoot).toBe(await realpath(root));
  });

  test("reports duplicate YAML keys and unknown structural keys", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    await writeFile(
      join(root, "dash-bored", "dash-bored.yaml"),
      "schemaVersion: 1\nname: First\nname: Second\nroot:\n  component: '@dash-bored/text'\n  props:\n    content: hi\n",
    );
    const duplicate = await inspectProject(root);
    expect(duplicate.ok).toBeFalse();
    expect(duplicate.diagnostics.some((item) => item.code === "YAML_INVALID")).toBeTrue();

    await writeFile(
      join(root, "dash-bored", "dash-bored.yaml"),
      stringify({ ...defaultConfig, unexpected: true }),
    );
    const unknown = await inspectProject(root);
    expect(unknown.ok).toBeFalse();
    expect(unknown.diagnostics.some((item) => item.code === "CONFIG_SCHEMA_INVALID")).toBeTrue();
  });

  test("requires an empty v1 lock file", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    await writeFile(
      join(root, "dash-bored", "dash-bored-lock.yaml"),
      "lockfileVersion: 1\ncomponents:\n  example: {}\n",
    );

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "LOCK_EXTERNAL_COMPONENTS_UNSUPPORTED",
    );
  });

  test("rejects a symlinked components directory that escapes the project", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    cleanup.push(root, outside);
    await createProject(root, {
      schemaVersion: 1,
      name: "Unsafe",
      root: { component: "./components/escape" },
    });
    await writeLocalComponent(outside, "escape", "export default () => null;");
    await rm(join(root, "dash-bored", "components"), { recursive: true });
    await symlink(join(outside, "dash-bored", "components"), join(root, "dash-bored", "components"));

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("PATH_OUTSIDE_PROJECT");
  });
});

describe("tree resolution and local compilation", () => {
  test("renders relative and absolute standalone config links without coupling validation", async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    cleanup.push(root, external);
    const namedDirectory = join(root, "dash-bored", "arvid");
    await createProject(root, {
      schemaVersion: 1,
      name: "Base",
      root: {
        component: "@dash-bored/stack",
        slots: {
          children: [
            { id: "relative", component: "./arvid" },
            { id: "broken", component: "./moved-away" },
            { id: "absolute", component: join(external, "dash-bored") },
          ],
        },
      },
    });
    await mkdir(join(namedDirectory, "components"), { recursive: true });
    await Promise.all([
      writeFile(join(namedDirectory, "dash-bored.yaml"), stringify({
        schemaVersion: 1,
        name: "Arvid",
        root: { component: "@dash-bored/text", props: { content: "Personal" } },
      })),
      writeFile(join(namedDirectory, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} })),
    ]);
    await createProject(external, {
      schemaVersion: 1,
      name: "External",
      root: { component: "@dash-bored/status", props: { label: "External", state: "healthy" } },
    });

    const result = await loadProjectDefinition(root);
    expect(result.ok).toBeTrue();
    const children = result.tree?.slots.children ?? [];
    expect(children[0]).toMatchObject({ source: "config", configName: "Arvid" });
    expect(children[0]?.slots.content?.[0]?.component).toBe("@dash-bored/text");
    expect(children[1]).toMatchObject({ source: "config" });
    expect(children[1]?.configError?.length).toBeGreaterThan(0);
    expect(children[2]).toMatchObject({ source: "config", configName: "External" });
    expect(result.diagnostics).toEqual([]);
  });

  test("loads local components from the linked bundle's own components directory", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Base",
      root: { id: "personal", component: "./arvid" },
    });
    const named = join(root, "dash-bored", "arvid");
    const component = join(named, "components", "personal-button");
    await mkdir(component, { recursive: true });
    await Promise.all([
      writeFile(join(named, "dash-bored.yaml"), stringify({
        schemaVersion: 1,
        name: "Arvid",
        root: { component: "./components/personal-button" },
      })),
      writeFile(join(named, "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} })),
      writeFile(join(component, "component.yaml"), stringify({
        schemaVersion: 1,
        id: "personal-button",
        name: "Personal button",
        description: "A bundle-local button.",
        entry: "./index.tsx",
        propsSchema: { type: "object", additionalProperties: false },
      })),
      writeFile(join(component, "index.tsx"), "export default () => <button>Mine</button>;"),
    ]);

    const result = await loadProjectDefinition(root, { compile: true });
    expect(result.ok).toBeTrue();
    const linked = result.tree?.slots.content?.[0];
    expect(linked?.source).toBe("local");
    expect(linked?.manifest?.id).toBe("personal::personal-button");
    expect(result.compiledComponents.map((item) => item.componentId)).toContain("personal::personal-button");
  });

  test("catalogs built-ins and valid or invalid project-local components", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root);
    await writeLocalComponent(root, "available", "export default () => null;");
    const invalid = join(root, "dash-bored", "components", "invalid");
    await mkdir(invalid);
    await writeFile(join(invalid, "component.yaml"), "schemaVersion: nope\n");

    const result = await loadProjectDefinition(root);
    expect(result.componentCatalog.some((item) => item.reference === "@dash-bored/stack" && item.available)).toBeTrue();
    expect(result.componentCatalog.some((item) => item.reference === "@dash-bored/env" && item.available)).toBeTrue();
    expect(result.componentCatalog.some((item) => item.reference === "./components/available" && item.available)).toBeTrue();
    const unavailable = result.componentCatalog.find((item) => item.reference === "./components/invalid");
    expect(unavailable?.available).toBeFalse();
    expect(unavailable?.diagnostics.length).toBeGreaterThan(0);
  });

  test("generates deterministic ids and rejects duplicate explicit ids", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const config: DashboardConfig = {
      schemaVersion: 1,
      name: "Ids",
      root: {
        component: "@dash-bored/stack",
        slots: {
          children: [
            { id: "same", component: "@dash-bored/text", props: { content: "one" } },
            { id: "same", component: "@dash-bored/text", props: { content: "two" } },
          ],
        },
      },
    };
    await createProject(root, config);
    const duplicate = await inspectProject(root);
    expect(duplicate.ok).toBeFalse();
    expect(duplicate.diagnostics.map((item) => item.code)).toContain("NODE_ID_DUPLICATE");

    config.root.slots = {
      children: [{ component: "@dash-bored/text", props: { content: "one" } }],
    };
    await writeFile(join(root, "dash-bored", "dash-bored.yaml"), stringify(config));
    const generated = await inspectProject(root);
    expect(generated.ok).toBeTrue();
    expect(generated.tree?.slots.children?.[0]?.id).toBe("root.children.0");
  });

  test("requires command ids and validates terminal references", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Processes",
      root: {
        component: "@dash-bored/stack",
        slots: {
          children: [
            {
              component: "@dash-bored/command",
              props: { label: "Run", command: "echo ok" },
            },
            {
              component: "@dash-bored/terminal",
              props: { processId: "missing" },
            },
          ],
        },
      },
    });
    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("NODE_ID_REQUIRED");
    expect(result.diagnostics.map((item) => item.code)).toContain("TERMINAL_PROCESS_UNKNOWN");
  });

  test("does not treat inherited object properties as declared slots", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Slots",
      root: {
        component: "@dash-bored/stack",
        slots: {
          constructor: {
            component: "@dash-bored/text",
            props: { content: "hidden" },
          },
        },
      },
    });

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("COMPONENT_SLOT_UNKNOWN");
  });

  test("compiles local TSX and CSS against the renderer runtime global", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Local",
      root: { component: "./components/example", props: { message: "Hello" } },
    });
    await writeLocalComponent(
      root,
      "example",
      `import { defineComponent, useEffect, useState } from "@dash-bored/component";
import "./style.css";
export default defineComponent(({ props, host }) => {
  const [count] = useState(1);
  useEffect(() => host.actions.register({
    id: "refresh",
    label: "Refresh example",
    run: () => host.dashboard.reload(),
  }), [host]);
  return <strong>{props.message}: {count}</strong>;
});`,
      { css: ".example { color: red; }" },
    );

    const result = await loadProjectDefinition(root, { compile: true });
    expect(result.ok).toBeTrue();
    expect(result.compiledComponents).toHaveLength(1);
    expect(result.compiledComponents[0]?.componentId).toBe("example");
    expect(result.compiledComponents[0]?.javascript).toContain(
      "__DASH_BORED_COMPONENT_RUNTIME__",
    );
    expect(result.compiledComponents[0]?.javascript).toContain("actions.register");
    expect(result.compiledComponents[0]?.css).toContain("color: red");
  });

  test("rejects bare imports from local components", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Restricted",
      root: { component: "./components/restricted" },
    });
    await writeLocalComponent(
      root,
      "restricted",
      'import value from "some-package"; export default () => value;',
    );

    const result = await loadProjectDefinition(root, { compile: true });
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("COMPONENT_COMPILE_FAILED");
  });

  test("keeps the built-in component id namespace reserved", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await createProject(root, {
      schemaVersion: 1,
      name: "Reserved",
      root: { component: "./components/reserved" },
    });
    await writeLocalComponent(root, "reserved", "export default () => null;");
    const manifestPath = join(root, "dash-bored", "components", "reserved", "component.yaml");
    const manifest = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, manifest.replace("id: reserved", "id: '@dash-bored/text'"));

    const result = await inspectProject(root);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.map((item) => item.code)).toContain("COMPONENT_ID_RESERVED");
  });
});
