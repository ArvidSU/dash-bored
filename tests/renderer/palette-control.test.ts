import { expect, test } from "bun:test";
import { MAX_COMMAND_PALETTE_QUERY_CHARS } from "../../src/shared/agent-control";
import { buildApplicationActions } from "../../src/renderer/lib/action-providers";

test("open-palette action forwards a bounded query to the palette controller", async () => {
  const opened: string[] = [];
  const noop = () => undefined;
  const actions = buildApplicationActions({
    snapshot: null,
    projects: [],
    activeView: "dashboard",
    sidebarExpanded: false,
    pendingAction: null,
    editing: false,
    draftDirty: false,
    draftValid: false,
    savingDraft: false,
    callbacks: {
      openCommandPalette: (query) => { opened.push(query ?? ""); },
      reloadApp: noop,
      focusWindow: noop,
      showDashboard: noop,
      showSettings: noop,
      toggleSidebar: noop,
      addDashboard: noop,
      openProject: noop,
      editDashboard: noop,
      saveDashboard: noop,
      cancelDashboard: noop,
      reloadProject: noop,
      trustProject: noop,
      revokeTrust: noop,
      runProcessQuickAction: noop,
      stopProcess: noop,
    },
  });
  const palette = actions.find(({ id }) => id === "app:open-palette");

  expect(palette).toBeDefined();
  await palette!.run({}, { query: "todo status" });
  expect(opened).toEqual(["todo status"]);
  expect(() => palette!.run({}, { query: "x".repeat(MAX_COMMAND_PALETTE_QUERY_CHARS + 1) }))
    .toThrow(`query must be a string of at most ${MAX_COMMAND_PALETTE_QUERY_CHARS} characters.`);
});
