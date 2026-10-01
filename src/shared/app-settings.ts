import type { AppSettings } from "./contracts";

export const DEFAULT_DASH_BORED_AGENT = "codex exec";
export const DEFAULT_COMMAND_PALETTE_SHORTCUT = "Mod+K";
export const DEFAULT_ACTION_SHORTCUTS = { "app:reload": "Mod+Shift+R" } as const;

/** Baseline persisted settings shared by the main process and renderer. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "builtin:default",
  themeMode: "dark",
  dashBoredAgent: DEFAULT_DASH_BORED_AGENT,
  sidebarExpandedByDefault: false,
  favoriteActionIds: [],
  commandPaletteShortcut: DEFAULT_COMMAND_PALETTE_SHORTCUT,
  clearPaletteInputOnKeepOpen: true,
  actionShortcuts: { ...DEFAULT_ACTION_SHORTCUTS },
};

/** Return independent nested settings collections for mutable consumers. */
export function cloneDefaultAppSettings(): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    favoriteActionIds: [...DEFAULT_APP_SETTINGS.favoriteActionIds],
    actionShortcuts: { ...DEFAULT_APP_SETTINGS.actionShortcuts },
  };
}
