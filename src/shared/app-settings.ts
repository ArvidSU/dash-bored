import type { AppSettings } from "./contracts";

export const DEFAULT_DASH_BORED_AGENT = "codex exec";
export const DEFAULT_COMMAND_PALETTE_SHORTCUT = "Mod+K";
/** App-local defaults; macOS conventions where one exists, mnemonics otherwise. */
export const DEFAULT_ACTION_SHORTCUTS = {
  "app:reload": "Mod+Shift+R",
  "app:show-settings": "Mod+,",
  "app:toggle-sidebar": "Mod+B",
  "app:add-dashboard": "Mod+O",
  "app:switch-dashboard": "Mod+P",
  "project:reload": "Mod+R",
  "project:edit": "Mod+E",
  "project:save-draft": "Mod+S",
  "agent:prompt": "Mod+Shift+A",
} as const;

/** Defaults that version 2 settings already carried; later defaults are merged into older files once. */
export const VERSION_2_DEFAULT_ACTION_IDS: readonly string[] = ["app:reload"];

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
