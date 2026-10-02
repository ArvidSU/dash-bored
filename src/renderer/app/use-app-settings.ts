import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, DashboardConfig, DashboardSettingsItem, ProjectListItem } from "../../shared/contracts";
import { cloneDefaultAppSettings } from "../../shared/app-settings";
import { host } from "../lib/rpc-client";
import { errorMessage, patchDashboardAppearance } from "./app-utils";
import type { Notices } from "./use-notices";

/**
 * The renderer's copy of app-wide settings. Updates apply optimistically and
 * are written to the host in order; only the newest write's result is kept.
 * The sidebar's expansion starts from, and follows changes to, its setting.
 */
export function useAppSettings(notices: Notices) {
  const [settings, setSettings] = useState<AppSettings>(cloneDefaultAppSettings);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const revision = useRef(0);
  const write = useRef<Promise<void>>(Promise.resolve());

  function load(initial: AppSettings): void {
    setSettings(initial);
    setSidebarExpanded(initial.sidebarExpandedByDefault);
  }

  function update(next: AppSettings, notice: string): void {
    const current = ++revision.current;
    if (next.sidebarExpandedByDefault !== settings.sidebarExpandedByDefault) {
      setSidebarExpanded(next.sidebarExpandedByDefault);
    }
    setSettings(next);
    write.current = write.current
      .catch(() => undefined)
      .then(async () => {
        const updated = await host.updateAppSettings(next);
        if (current === revision.current) {
          setSettings(updated);
          notices.showNotice(notice);
        }
      })
      .catch((error: unknown) => {
        if (current === revision.current) notices.setError(errorMessage(error));
      });
  }

  /**
   * Re-reads settings the host may have rewritten and adopts them when
   * `changed` says so, unless a local update started since. Returns a cancel.
   */
  function reloadIfChanged(changed: (next: AppSettings) => boolean, notice: string): () => void {
    const current = revision.current;
    let active = true;
    void host.getAppSettings().then((next) => {
      if (!active || current !== revision.current || !changed(next)) return;
      setSettings(next);
      notices.showNotice(notice);
    }).catch(() => undefined);
    return () => { active = false; };
  }

  function saveAgent(command: string | null): void {
    update(
      { ...settings, dashBoredAgent: command },
      command === null
        ? "App-wide DASH_BORED_AGENT cleared; the project .env will be used when available."
        : `DASH_BORED_AGENT is now ${command}.`,
    );
  }

  function toggleFavoriteAction(id: string): void {
    const favoriteActionIds = settings.favoriteActionIds.includes(id)
      ? settings.favoriteActionIds.filter((candidate) => candidate !== id)
      : [...settings.favoriteActionIds, id];
    update(
      { ...settings, favoriteActionIds },
      favoriteActionIds.includes(id) ? "Action added to favorites." : "Action removed from favorites.",
    );
  }

  const favoriteActionIds = useMemo(
    () => new Set(settings.favoriteActionIds),
    [settings.favoriteActionIds],
  );

  return {
    settings,
    favoriteActionIds,
    sidebarExpanded,
    setSidebarExpanded,
    load,
    update,
    reloadIfChanged,
    saveAgent,
    toggleFavoriteAction,
  };
}

/** Per-dashboard appearance rows for the Settings view, read while it is open. */
export function useDashboardSettings(
  notices: Notices,
  open: boolean,
  projects: readonly ProjectListItem[],
  snapshotRevision: string | number | undefined,
) {
  const [items, setItems] = useState<DashboardSettingsItem[]>([]);
  const revision = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++revision.current;
    void Promise.all(projects.map(async (project): Promise<DashboardSettingsItem> => {
      try {
        const source = await host.getDashboardConfigSource(project.configPath);
        return { ...project, theme: source.config.theme, themeMode: source.config.themeMode };
      } catch (error) {
        return { ...project, error: errorMessage(error) };
      }
    })).then((next) => {
      if (current === revision.current) setItems(next);
    });
  }, [open, projects, snapshotRevision]);

  async function updateAppearance(
    dashboard: DashboardSettingsItem,
    change: Pick<DashboardConfig, "theme" | "themeMode">,
  ): Promise<void> {
    try {
      const source = await host.getDashboardConfigSource(dashboard.configPath);
      const draft = patchDashboardAppearance(source.config, change);
      await host.saveDashboardConfig(draft, source.configRevision, source.configPath);
      setItems((current) => current.map((item) => item.configPath === dashboard.configPath
        ? { ...item, theme: draft.theme, themeMode: draft.themeMode, error: undefined }
        : item));
      notices.showNotice(`${dashboard.dashboardName?.trim() || "Dashboard"} appearance updated.`);
    } catch (error) {
      notices.setError(errorMessage(error));
    }
  }

  return { items, updateAppearance };
}

export type AppSettingsState = ReturnType<typeof useAppSettings>;
