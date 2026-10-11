import { expect, test } from "bun:test";
import type { ProjectSnapshot } from "../../src/shared/contracts";
import { agentActionRefusal } from "../../src/shared/agent-control";
import { builtinPromptTemplates, promptTemplateSummaries } from "../../src/shared/prompt-templates";
import { buildApplicationActions, type ApplicationActionContext } from "../../src/renderer/lib/action-providers";
import { rankActions, rankPaletteEntries } from "../../src/renderer/lib/actions";

function context(receive: (args: Record<string, unknown>, caller?: string) => void): ApplicationActionContext {
  const noop = () => undefined;
  return {
    snapshot: { projectRoot: "/project", trusted: true, tree: null, processes: [], requestedPermissions: [] } as unknown as ProjectSnapshot,
    projects: [], activeView: "dashboard", sidebarExpanded: false, pendingAction: null,
    editing: false, draftDirty: false, draftValid: false, savingDraft: false,
    promptTemplates: [...promptTemplateSummaries(builtinPromptTemplates()), {
      name: "implement-todo", description: "Implement a backlog item", scope: "project", input: "optional", builtin: false, vars: { id: "Backlog item ID" },
    }],
    callbacks: {
      reloadApp: noop, focusWindow: noop, showDashboard: noop, showSettings: noop,
      toggleSidebar: noop, addDashboard: noop, openProject: noop, editDashboard: noop,
      saveDashboard: noop, cancelDashboard: noop, reloadProject: noop, trustProject: noop,
      revokeTrust: noop, runProcessQuickAction: noop, stopProcess: noop, requestAgentPrompt: receive,
    },
  };
}

test("palette discovers named templates and opens the reviewed composer while direct prompt invocations stay unchanged", () => {
  const received: unknown[] = [];
  const source = context((args, caller) => received.push({ args, caller }));
  const actions = buildApplicationActions(source);
  const chooser = actions.find(({ id }) => id === "agent:prompt-template")!;
  expect(chooser.enabled).toBeTrue();
  expect(chooser.choices?.[0]?.options).toContainEqual({ value: "implement-todo", label: "implement-todo", description: "project · Implement a backlog item · Variables: id" });
  expect(rankPaletteEntries(actions, "implement-todo")[0]).toMatchObject({ kind: "option", action: { id: chooser.id } });
  expect(rankActions(actions, "Send prompt to agent").map(({ id }) => id)).toEqual([chooser.id]);
  chooser.run({ template: "implement-todo" });
  expect(received).toEqual([{ args: { template: "implement-todo" }, caller: undefined }]);
  const direct = actions.find(({ id }) => id === "agent:prompt")!;
  expect(direct.choices).toBeUndefined();
  direct.run({}, { prompt: "Review it", template: "dash-bored/project", vars: { id: "todo-1" } }, "button");
  direct.run();
  expect(received.slice(1)).toEqual([
    { args: { prompt: "Review it", template: "dash-bored/project", vars: { id: "todo-1" } }, caller: "button" },
    { args: {}, caller: undefined },
  ]);
  expect(() => chooser.run({ template: "removed" })).toThrow("Choose an available prompt template.");
  expect(agentActionRefusal(chooser)).toContain("user review");
});

test("template discovery stays unavailable without a target, while loading, on failure, and before trust", () => {
  const source = context(() => undefined);
  for (const reason of ["Loading prompt templates…", "Prompt templates could not be loaded."]) {
    const chooser = buildApplicationActions({ ...source, promptTemplates: [], promptTemplatesReason: reason })
      .find(({ id }) => id === "agent:prompt-template")!;
    expect(chooser).toMatchObject({ enabled: false, disabledReason: reason });
    expect(chooser.choices).toBeUndefined();
  }
  expect(buildApplicationActions({ ...source, snapshot: null }).find(({ id }) => id === "agent:prompt-template"))
    .toMatchObject({ enabled: false });
  expect(buildApplicationActions({ ...source, snapshot: { ...source.snapshot!, trusted: false } })
    .find(({ id }) => id === "agent:prompt-template"))
    .toMatchObject({ enabled: false, disabledReason: "Trust the project before sending an agent prompt." });
});
