import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardConfig } from "../../src/shared/contracts";
import { compileLocalComponents, resolveComponentTree, resolveProjectLocation } from "../../src/core";
import { createProject, removeTemporaryDirectory, temporaryDirectory, writeLocalComponent } from "./helpers";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

test("parallel local builds preserve component and diagnostic input order", async () => {
  const root = await temporaryDirectory();
  cleanup.push(root);
  const components = ["broken-first", "valid-middle", "broken-last"] as const;
  const config: DashboardConfig = {
    schemaVersion: 4,
    name: "Compile order",
    root: {
      component: "./components/external/core/group",
      children: components.map((name) => ({ node: { component: `./components/${name}` } })),
    },
  };
  await createProject(root, config);
  await writeLocalComponent(root, "broken-first", "export default () => <section>;\n");
  await writeLocalComponent(root, "valid-middle", "export default () => <section />;\n");
  await writeLocalComponent(root, "broken-last", "export default () => <article>;\n");

  const location = await resolveProjectLocation(root);
  const resolved = await resolveComponentTree(location, config);
  const definitionsByReference = new Map(resolved.localComponents.map((definition) => [definition.reference, definition]));
  const definitions = components.map((name) => definitionsByReference.get(`./components/${name}`)!);
  expect(definitions.every(Boolean)).toBeTrue();

  const result = await compileLocalComponents(definitions);
  expect(result.components.map((component) => component.componentId)).toEqual(["valid-middle"]);
  expect(result.diagnostics.map((item) => item.file)).toEqual([
    join(location.componentsDirectory, "broken-first", "index.tsx"),
    join(location.componentsDirectory, "broken-last", "index.tsx"),
  ]);
  expect(result.diagnostics.map((item) => item.code)).toEqual([
    "COMPONENT_COMPILE_FAILED",
    "COMPONENT_COMPILE_FAILED",
  ]);
});
