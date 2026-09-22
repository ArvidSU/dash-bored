import { afterEach, describe, expect, test } from "bun:test";
import { validateActionArguments } from "../../src/core/action-arguments";
import { actionInvocation } from "../../src/shared/action-invocation";
import { loadProjectDefinition } from "../../src/core";
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
    await createProject(root, { schemaVersion: 3, name: "Action arguments", root: {
      id: "prompt-button", component: "@dash-bored/button",
      props: { name: "Start", action: { run: "agent:prompt", with: { prompt: "Inspect the failing workflow." } } },
    } });
    const result = await loadProjectDefinition(root);
    expect(result.diagnostics.filter((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")).toEqual([]);

    await createProject(root, { schemaVersion: 3, name: "Invalid arguments", root: {
      id: "prompt-button", component: "@dash-bored/button",
      props: { name: "Start", action: { run: "agent:prompt", with: { prompt: 42 } } },
    } });
    const invalid = await loadProjectDefinition(root);
    expect(invalid.diagnostics.some((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID")).toBeTrue();
  });
});
