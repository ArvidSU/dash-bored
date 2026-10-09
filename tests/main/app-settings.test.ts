import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSettingsStore, resolveDashBoredAgent } from "../../src/main/app-settings";
import { cloneDefaultAppSettings, DEFAULT_ACTION_SHORTCUTS } from "../../src/shared/app-settings";
import { projectThemeReference } from "../../src/shared/themes";
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

test("shared app settings clones mutable collections", () => {
  const first = cloneDefaultAppSettings();
  const second = cloneDefaultAppSettings();
  expect(first.favoriteActionIds).not.toBe(second.favoriteActionIds);
  expect(first.actionShortcuts).not.toBe(second.actionShortcuts);
  first.favoriteActionIds.push("app:reload");
  first.actionShortcuts["app:test"] = "Mod+T";
  expect(second.favoriteActionIds).toEqual([]);
  expect(second.actionShortcuts).toEqual(DEFAULT_ACTION_SHORTCUTS);
});

describe("AppSettingsStore", () => {
  test("uses the configured default and atomically persists an app-wide agent command", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const path = join(directory, "state", "settings-v1.json");
    const store = new AppSettingsStore(path, "codex exec");

    expect(await store.get()).toEqual({
      theme: "builtin:default",
      themeMode: "dark",
      dashBoredAgent: "codex exec",
      sidebarExpandedByDefault: false,
      favoriteActionIds: [],
      commandPaletteShortcut: "Mod+K",
      clearPaletteInputOnKeepOpen: true,
      actionShortcuts: DEFAULT_ACTION_SHORTCUTS,
    });
    const updated = await store.update({
      dashBoredAgent: "  claude -p  ",
      sidebarExpandedByDefault: true,
      favoriteActionIds: ["app:reload", "app:reload", " component:refresh "],
      commandPaletteShortcut: "Mod+P",
      clearPaletteInputOnKeepOpen: false,
      actionShortcuts: {
        "app:reload": "Mod+Shift+R",
        "app:show-settings": "Mod+,",
        "component:refresh": "Alt+R",
      },
    });
    expect(updated).toEqual({
      theme: "builtin:default",
      themeMode: "dark",
      dashBoredAgent: "claude -p",
      sidebarExpandedByDefault: true,
      favoriteActionIds: ["app:reload", "component:refresh"],
      commandPaletteShortcut: "Mod+P",
      clearPaletteInputOnKeepOpen: false,
      actionShortcuts: {
        "app:reload": "Mod+Shift+R",
        "app:show-settings": "Mod+,",
        "component:refresh": "Alt+R",
      },
    });
    expect(await new AppSettingsStore(path, "ignored").get()).toEqual({
      theme: "builtin:default",
      themeMode: "dark",
      dashBoredAgent: "claude -p",
      sidebarExpandedByDefault: true,
      favoriteActionIds: ["app:reload", "component:refresh"],
      commandPaletteShortcut: "Mod+P",
      clearPaletteInputOnKeepOpen: false,
      actionShortcuts: {
        "app:reload": "Mod+Shift+R",
        "app:show-settings": "Mod+,",
        "component:refresh": "Alt+R",
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      theme: "builtin:default",
      themeMode: "dark",
      version: 3,
      dashBoredAgent: "claude -p",
      sidebarExpandedByDefault: true,
      favoriteActionIds: ["app:reload", "component:refresh"],
      commandPaletteShortcut: "Mod+P",
      clearPaletteInputOnKeepOpen: false,
      actionShortcuts: {
        "app:reload": "Mod+Shift+R",
        "app:show-settings": "Mod+,",
        "component:refresh": "Alt+R",
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const cleared = await store.update({ ...updated, dashBoredAgent: null });
    expect(cleared.dashBoredAgent).toBeNull();
    expect(await new AppSettingsStore(path, "ignored").get()).toMatchObject({ dashBoredAgent: null });
    expect(JSON.parse(await readFile(path, "utf8")).dashBoredAgent).toBeNull();
  });

  test("falls back for corrupt state and rejects invalid updates without changing memory", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const path = join(directory, "settings-v1.json");
    await writeFile(path, '{"version":1,"dashBoredAgent":""}\n');
    const store = new AppSettingsStore(path, "gemini -p");

    expect(await store.get()).toEqual({
      theme: "builtin:default",
      themeMode: "dark",
      dashBoredAgent: "gemini -p",
      sidebarExpandedByDefault: false,
      favoriteActionIds: [],
      commandPaletteShortcut: "Mod+K",
      clearPaletteInputOnKeepOpen: true,
      actionShortcuts: DEFAULT_ACTION_SHORTCUTS,
    });
    await expect(store.update({
      dashBoredAgent: "",
      sidebarExpandedByDefault: false,
      favoriteActionIds: [],
      commandPaletteShortcut: "Mod+K",
      clearPaletteInputOnKeepOpen: true,
      actionShortcuts: {},
    })).rejects.toMatchObject({
      code: "APP_SETTINGS_INVALID",
    });
    expect((await store.get()).dashBoredAgent).toBe("gemini -p");
  });

  test("version 2 settings gain newer default shortcuts once, without overriding user bindings", async () => {
    const directory = await temporaryDirectory(); cleanup.push(directory);
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      dashBoredAgent: null,
      commandPaletteShortcut: "Mod+P",
      // app:reload was cleared; Mod+B now runs a component action.
      actionShortcuts: { "app:show-settings": "Alt+S", "component:refresh": "Mod+B" },
    }));
    const store = new AppSettingsStore(path);
    const migrated = (await store.get()).actionShortcuts;
    expect(migrated).toEqual({
      "app:show-settings": "Alt+S",
      "component:refresh": "Mod+B",
      "app:add-dashboard": "Mod+O",
      "project:reload": "Mod+R",
      "project:edit": "Mod+E",
      "project:save-draft": "Mod+S",
      "agent:prompt": "Mod+Shift+A",
    });

    const { ["project:edit"]: _cleared, ...remaining } = migrated;
    await store.update({ ...await store.get(), actionShortcuts: remaining });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
    expect((await new AppSettingsStore(path).get()).actionShortcuts).toEqual(remaining);
  });

  test("uses the bundle environment after the app override is cleared", () => {
    expect(resolveDashBoredAgent(null, { DASH_BORED_AGENT: "project-agent --run" })).toBe("project-agent --run");
    expect(resolveDashBoredAgent(null, {})).toBe("codex exec");
    expect(resolveDashBoredAgent("app-agent", { DASH_BORED_AGENT: "project-agent" })).toBe("app-agent");
  });

  test("old settings default to clearing keep-open searches and explicit false survives reload", async () => {
    const directory = await temporaryDirectory(); cleanup.push(directory);
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 2, dashBoredAgent: null }));
    const store = new AppSettingsStore(path);
    expect((await store.get()).clearPaletteInputOnKeepOpen).toBeTrue();
    await store.update({ ...await store.get(), clearPaletteInputOnKeepOpen: false });
    expect((await new AppSettingsStore(path).get()).clearPaletteInputOnKeepOpen).toBeFalse();
    await writeFile(path, JSON.stringify({ version: 2, dashBoredAgent: null, clearPaletteInputOnKeepOpen: "false" }));
    expect((await new AppSettingsStore(path).get()).clearPaletteInputOnKeepOpen).toBeTrue();
  });
});


test("theme settings preserve old dark defaults and persist Light/System with any installed theme reference", async () => {
  const directory = await temporaryDirectory(); cleanup.push(directory);
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({ version: 2, dashBoredAgent: null }));
  const store = new AppSettingsStore(path);
  expect((await store.get()).themeMode).toBe("dark");
  for (const themeMode of ["light", "system"] as const) {
    await store.update({ ...await store.get(), theme: "global:ocean", themeMode });
    expect((await new AppSettingsStore(path).get()).themeMode).toBe(themeMode);
    expect((await new AppSettingsStore(path).get()).theme).toBe("global:ocean");
  }
  await store.update({ ...await store.get(), theme: "./themes/local" });
  expect((await store.get()).theme).toBe("./themes/local");
  const qualified = projectThemeReference("/workspace/example/.dash-bored/dash-bored.yaml", "./themes/external/remote");
  await store.update({ ...await store.get(), theme: qualified });
  expect((await new AppSettingsStore(path).get()).theme).toBe(qualified);
});
