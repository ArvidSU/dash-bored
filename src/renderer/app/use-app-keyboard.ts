import { useEffect, useState } from "react";
import type { AppSettings, ProjectListItem } from "../../shared/contracts";
import { keyboardEventMatchesShortcut } from "../../shared/keyboard-shortcut";
import { useLatestRef } from "./use-latest-ref";

/** Whether ⌘ is held, so the sidebar can show its dashboard numbers. */
export function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const update = (event: globalThis.KeyboardEvent) => setHeld(event.metaKey);
    const clear = () => setHeld(false);
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return held;
}

export interface AppShortcutOptions {
  settings: AppSettings;
  paletteOpen: boolean;
  projects: readonly ProjectListItem[];
  pending: string | null;
  selectProject(project: ProjectListItem, toggleSidebarWhenActive: boolean): Promise<void>;
  openPalette(): void;
  runAction(reference: string): void;
}

/** ⌘1–9 switch dashboards; the palette and action shortcuts come from settings. */
export function useAppShortcuts({
  settings,
  paletteOpen,
  projects,
  pending,
  selectProject,
  openPalette,
  runAction,
}: AppShortcutOptions): void {
  // Keep the window listener on the current draft guard without rebinding it
  // for every unrelated process or source update.
  const selectProjectRef = useLatestRef(selectProject);
  const runActionRef = useLatestRef(runAction);
  const openPaletteRef = useLatestRef(openPalette);
  useEffect(() => {
    function openFromKeyboard(event: globalThis.KeyboardEvent): void {
      if (event.repeat) return;
      if (!paletteOpen && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const project = projects[Number(event.key) - 1];
        if (project) {
          event.preventDefault();
          if (pending === null) void selectProjectRef.current(project, true);
        }
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      if (keyboardEventMatchesShortcut(event, settings.commandPaletteShortcut)) {
        event.preventDefault();
        openPaletteRef.current();
        return;
      }
      const actionId = Object.entries(settings.actionShortcuts)
        .find(([, shortcut]) => keyboardEventMatchesShortcut(event, shortcut))?.[0];
      if (actionId) {
        event.preventDefault();
        runActionRef.current(actionId);
      }
    }
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, [settings.actionShortcuts, settings.commandPaletteShortcut, paletteOpen, projects, pending]);
}
