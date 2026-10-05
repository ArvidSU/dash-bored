import { afterEach, describe, expect, test } from "bun:test";
import { validateActionArguments } from "../../src/core/action-arguments";
import { actionInvocation } from "../../src/shared/action-invocation";
import { loadProjectDefinition } from "../../src/core";
import type { DashboardConfig } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const temporaryProjects: string[] = [];
afterEach(async () => Promise.all(temporaryProjects.splice(0).map(removeTemporaryDirectory)));

describe("parameterized action arguments", () => {
  test("validates declared schemas and rejects unknown or mistyped values", () => {
    const schema = { type: "object", additionalProperties: false, properties: { prompt: { type: "string", minLength: 1 } }, required: ["prompt"] };
    expect(validateActionArguments(schema, { prompt: "Fix the failing test" })).toBeUndefined();
    expect(validateActionArguments(schema, { prompt: 4 })).toContain("prompt");
    expect(validateActionArguments(schema, { prompt: "ok", extra: true })).toContain("additional properties");
  });

  test("keeps string references argument-free and parses object invocations", () => {
    expect(actionInvocation("focus:overview")).toEqual({ run: "focus:overview", with: {} });
    expect(actionInvocation({ run: "agent:prompt", with: { prompt: "Review this" } })).toEqual({ run: "agent:prompt", with: { prompt: "Review this" } });
    expect(actionInvocation({ run: "agent:prompt", with: [] })).toBeUndefined();
  });

  test("validates agent:prompt arguments while loading a dashboard", async () => {
    const root = await temporaryDirectory();
    temporaryProjects.push(root);
    await createProject(root, { schemaVersion: 4, name: "Action arguments", root: {
      id: "prompt-button", component: "./components/external/core/button",
      props: { name: "Start", action: { run: "agent:prompt", with: { prompt: "Inspect the failing workflow." } } },
    } });
    const result = await loadProjectDefinition(root);
    expect(result.diagnostics.filter((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")).toEqual([]);

    await createProject(root, { schemaVersion: 4, name: "Invalid arguments", root: {
      id: "prompt-button", component: "./components/external/core/button",
      props: { name: "Start", action: { run: "agent:prompt", with: { prompt: 42 } } },
    } });
    const invalid = await loadProjectDefinition(root);
    expect(invalid.diagnostics.some((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")).toBeTrue();
  });

  test("reveal accepts only an item ID, including item templates in list actions", async () => {
    const root = await temporaryDirectory();
    temporaryProjects.push(root);
    const dashboard = (withArgs: Record<string, unknown>): DashboardConfig => ({ schemaVersion: 4, name: "Reveal item", root: {
      id: "root", component: "./components/external/core/group", children: { axis: "vertical",
        first: { node: { id: "attention", component: "./components/external/core/list", props: { source: { inline: [] },
          itemActions: [{ name: "Show", action: { run: "reveal:backlog", with: withArgs } }] } } },
        second: { node: { id: "backlog", component: "./components/external/core/list", props: { todos: [] } } },
      } } });
    await createProject(root, dashboard({ item: "${item.id}" }));
    const valid = await loadProjectDefinition(root);
    expect(valid.diagnostics.filter((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")).toEqual([]);

    await createProject(root, dashboard({ item: "todo-1", scroll: true }));
    const invalid = await loadProjectDefinition(root);
    expect(invalid.diagnostics.find((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")?.message).toContain("reveal arguments are invalid");
  });
});
