import { useEffect, useLayoutEffect, useState } from "react";
import type { AppSettings, ProjectSnapshot } from "../../shared/contracts";
import { parseProjectThemeReference, type ThemeCatalogItem } from "../../shared/themes";
import { applyTheme } from "../lib/theme";
import { mergeThemeCatalog, type DashboardEditSession } from "./app-utils";
import type { AppSettingsState } from "./use-app-settings";

function useSystemDark(): boolean {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return systemDark;
}

/**
 * Applies the window theme: the active dashboard's (draft first, so unsaved
 * appearance previews) over the app default, resolved against both catalogs.
 */
export function useAppTheme(
  themes: readonly ThemeCatalogItem[],
  snapshot: ProjectSnapshot | null,
  editSession: DashboardEditSession | null,
  appSettings: AppSettingsState,
): void {
  const systemDark = useSystemDark();
  const settings: AppSettings = appSettings.settings;
  // Legacy `./` default-theme references point into one project; rewrite them
  // to that project's catalog reference once the catalog can resolve them.
  useEffect(() => {
    const legacyReference = settings.theme;
    if (!legacyReference?.startsWith("./") || !snapshot?.configPath) return;
    const replacement = themes.find((item) => {
      const source = parseProjectThemeReference(item.reference);
      return source?.configPath === snapshot.configPath && source?.localReference === legacyReference;
    });
    if (!replacement) return;
    appSettings.update({ ...settings, theme: replacement.reference }, "Default theme reference updated.");
  }, [themes, settings, snapshot?.configPath]);
  useLayoutEffect(() => {
    const catalog = mergeThemeCatalog(themes, snapshot?.themeCatalog);
    const source = editSession?.configPath === snapshot?.configPath ? editSession?.draft : snapshot?.config;
    applyTheme(catalog, source?.theme, settings.theme, source?.themeMode ?? settings.themeMode, systemDark);
  }, [themes, snapshot?.themeCatalog, snapshot?.configPath, snapshot?.config?.theme, snapshot?.config?.themeMode, editSession?.configPath, editSession?.draft.theme, editSession?.draft.themeMode, settings.theme, settings.themeMode, systemDark]);
}
