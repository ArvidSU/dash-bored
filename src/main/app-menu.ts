import { ApplicationMenu } from "electrobun/main";
import type { AppSettings } from "../shared/contracts";
import { keyboardShortcutAccelerator } from "../shared/keyboard-shortcut";

function accelerator(shortcut: string | null | undefined): { accelerator?: string } {
  const value = keyboardShortcutAccelerator(shortcut);
  return value ? { accelerator: value } : {};
}

/** Installs the native menu; shortcuts follow the app settings. */
export function setApplicationMenu(settings: AppSettings): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: "dash-bored",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Show Command Palette", action: "open-command-palette", ...accelerator(settings.commandPaletteShortcut) },
        { label: "Reload App", action: "reload-app", ...accelerator(settings.actionShortcuts["app:reload"]) },
      ],
    },
  ]);
}

export function onApplicationMenuAction(handlers: { openCommandPalette(): void; reloadApp(): void }): void {
  ApplicationMenu.on("application-menu-clicked", (event) => {
    const action = (event as { data?: { action?: unknown } }).data?.action;
    if (action === "open-command-palette") handlers.openCommandPalette();
    if (action === "reload-app") handlers.reloadApp();
  });
}
