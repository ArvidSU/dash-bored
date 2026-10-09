import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectDefinition } from "../../src/core";
import {
  builtinPromptTemplates,
  loadPromptTemplates,
  parsePromptTemplate,
  prepareAgentPrompt,
  promptTemplateSummaries,
  type AgentPromptRequest,
  type PromptTemplateSet,
} from "../../src/core/prompt-templates";
import type { DashboardConfig } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const temporaryProjects: string[] = [];
afterEach(async () => Promise.all(temporaryProjects.splice(0).map(removeTemporaryDirectory)));

const builtins: PromptTemplateSet = { templates: builtinPromptTemplates(), diagnostics: [] };

function request(overrides: Partial<AgentPromptRequest> = {}): AgentPromptRequest {
  return {
    input: "  Add a Save button to the unsaved-changes alert.  ",
    projectRoot: "/project",
    configPath: "/project/.dash-bored/dash-bored.yaml",
    configDirectory: "/project/.dash-bored",
    component: {
      id: "yaml-todo",
      reference: "./components/external/core/list",
      path: "/project/.dash-bored/dash-bored.yaml#id=yaml-todo",
      name: "Project backlog",
    },
    ...overrides,
  };
}

async function bundleWithPrompts(prompts: Record<string, string>): Promise<{ root: string; directory: string }> {
  const root = await temporaryDirectory();
  temporaryProjects.push(root);
  await createProject(root);
  const directory = join(root, ".dash-bored");
  await mkdir(join(directory, "prompts"), { recursive: true });
  await Promise.all(Object.entries(prompts).map(([name, source]) => writeFile(join(directory, "prompts", name), source, "utf8")));
  return { root, directory };
}

describe("prompt templates", () => {
  test("agent:prompt defaults to project work, not a dashboard edit", () => {
    const { template, prompt } = prepareAgentPrompt(builtins, request({ vars: { backlogItem: "todo-022" } }));
    expect(template.name).toBe("project");
    expect(template.scope).toBe("project");
    expect(prompt).toContain("do work in this project");
    expect(prompt).toContain("not the dashboard configuration");
    expect(prompt).toContain("Requested from: Project backlog (component `yaml-todo`, ./components/external/core/list)");
    expect(prompt).toContain("Context:\n- backlogItem: todo-022\n");
    expect(prompt).toEndWith("Request:\nAdd a Save button to the unsaved-changes alert.");
    expect(prompt).not.toContain("{{");
  });

  test("the dashboard template keeps the component-change framing", () => {
    const { template, prompt } = prepareAgentPrompt(builtins, request({ template: "dashboard" }));
    expect(template.scope).toBe("dashboard");
    expect(prompt).toContain("dash-bored product and component-tree model");
    expect(prompt).toContain("Target component path: /project/.dash-bored/dash-bored.yaml#id=yaml-todo");
    expect(prompt).not.toContain("Context:");
    expect(prompt).toEndWith("User request:\nAdd a Save button to the unsaved-changes alert.");
  });

  test("renders sections, inverted sections, and removes standalone tag lines", () => {
    const tokens = parsePromptTemplate("A\n{{#input}}\nhas {{input}}\n{{/input}}\n{{^input}}\nnone\n{{/input}}\nB");
    expect(tokens.map((token) => token.type)).toEqual(["text", "section", "section", "text"]);
    expect(() => parsePromptTemplate("{{#open}} never closed")).toThrow("never closed");
    expect(() => parsePromptTemplate("{{/stray}}")).toThrow("Unexpected closing tag");
  });

  test("requires input unless the template makes it optional", () => {
    expect(() => prepareAgentPrompt(builtins, request({ input: " " }))).toThrow("needs a request");
    expect(prepareAgentPrompt(builtins, request({ input: "", allowEmptyInput: true })).prompt).toEndWith("Request:");
  });

  test("bundle templates declare vars and env, and may include the shipped default", async () => {
    const { directory } = await bundleWithPrompts({
      "implement-todo.md": [
        "---",
        "description: Implement a backlog item",
        "input: optional",
        "vars:",
        "  id: Backlog item ID",
        "env: [TEAM]",
        "---",
        "{{> dash-bored/project}}",
        "",
        "Implement {{vars.id}} for team {{env.TEAM}}, then mark it done.",
        "",
      ].join("\n"),
      "project.md": "Repository rules first.\n\n{{> project}}\n",
    });
    const set = await loadPromptTemplates(directory);
    expect(set.diagnostics).toEqual([]);
    const implement = prepareAgentPrompt(set, request({
      template: "implement-todo",
      input: "",
      vars: { id: "todo-022" },
      env: { TEAM: "cockpit", SECRET: "never" },
    }));
    expect(implement.template.scope).toBe("project");
    expect(implement.prompt).toContain("do work in this project");
    expect(implement.prompt).toEndWith("Request:\n\nImplement todo-022 for team cockpit, then mark it done.");
    expect(implement.prompt).not.toContain("never");
    // A same-named override replaces the default; `{{> project}}` inside it means the shipped one.
    const override = prepareAgentPrompt(set, request());
    expect(override.prompt.startsWith("Repository rules first.\n\nYou were asked")).toBeTrue();
    expect(() => prepareAgentPrompt(set, request({ template: "implement-todo", vars: { other: "x" } }))).toThrow("does not declare vars: other");
    // The picker lists the effective set: built-ins first; an override counts as the bundle's.
    const summaries = promptTemplateSummaries(set.templates);
    expect(summaries.map((item) => [item.name, item.builtin])).toEqual([
      ["dashboard", true],
      ["implement-todo", false],
      ["project", false],
    ]);
    expect(summaries.find((item) => item.name === "implement-todo")?.vars).toEqual({ id: expect.any(String) });
    expect(summaries.find((item) => item.name === "dashboard")?.vars).toBeNull();
  });

  test("reports invalid template files and undeclared references", async () => {
    const { root, directory } = await bundleWithPrompts({
      "bad-scope.md": "---\nscope: everything\n---\nBody",
      "undeclared.md": "Use {{vars.missing}} and {{env.HOME}} and {{secret}}.",
      "Upper.md": "Body",
      "unknown-partial.md": "{{> nope}}",
    });
    await symlink("/etc/hosts", join(directory, "prompts", "linked.md"));
    const set = await loadPromptTemplates(directory);
    const messages = set.diagnostics.map((item) => `${item.file?.slice(directory.length + 1)}: ${item.message}`);
    expect(messages).toContain("prompts/bad-scope.md: scope must be project or dashboard.");
    expect(messages).toContain("prompts/undeclared.md: {{vars.missing}} uses a variable that is not declared in vars.");
    expect(messages).toContain("prompts/undeclared.md: {{env.HOME}} uses an environment value that is not declared in env.");
    expect(messages).toContain("prompts/undeclared.md: {{secret}} is not a known prompt value.");
    expect(messages).toContain("prompts/Upper.md: Prompt template file names must be lowercase letters, digits, and hyphens.");
    expect(messages).toContain("prompts/unknown-partial.md: {{> nope}} names an unknown template.");
    expect(messages).toContain("prompts/linked.md: Prompt templates must be regular files.");
    expect(() => prepareAgentPrompt(set, request({ template: "undeclared" }))).toThrow("is invalid");
    // Template diagnostics surface with the rest of the dashboard's.
    const loaded = await loadProjectDefinition(root);
    expect(loaded.diagnostics.filter((item) => item.code === "PROMPT_TEMPLATE_INVALID").length).toBe(set.diagnostics.length);
  });

  test("dashboard loading checks agent:prompt templates and vars", async () => {
    const dashboard = (withArgs: Record<string, unknown>): DashboardConfig => ({ schemaVersion: 4, name: "Templates", root: {
      id: "backlog", component: "./components/external/core/list", props: { todos: [],
        itemActions: [{ name: "Implement", action: { run: "agent:prompt", with: withArgs } }] },
    } });
    const { root } = await bundleWithPrompts({ "implement-todo.md": "---\nvars:\n  id: Item\n---\nImplement {{vars.id}}." });
    const invalidArguments = async () => (await loadProjectDefinition(root)).diagnostics
      .filter((item) => item.code === "COMPONENT_ACTION_ARGUMENTS_INVALID").map((item) => item.message);

    await createProject(root, dashboard({ template: "implement-todo", vars: { id: "${item.id}" } }));
    expect(await invalidArguments()).toEqual([]);
    await createProject(root, dashboard({ prompt: "${item.description}", vars: { anything: "${item.id}" } }));
    expect(await invalidArguments()).toEqual([]);
    await createProject(root, dashboard({ template: "dash-bored/dashboard", prompt: "${item.description}" }));
    expect(await invalidArguments()).toEqual([]);
    await createProject(root, dashboard({ template: "missing" }));
    expect((await invalidArguments())[0]).toContain('prompt template "missing" is not defined');
    await createProject(root, dashboard({ template: "implement-todo", vars: { other: "${item.id}" } }));
    expect((await invalidArguments())[0]).toContain("does not declare vars: other");
  });
});
