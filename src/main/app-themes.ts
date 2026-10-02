import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolveProjectLocation } from "../core/index";
import { isPackageWorkPath } from "../core/package-store";
import { loadApplicationThemeCatalog, personalThemesDirectory } from "../core/themes";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import type { ThemeCatalogItem } from "../shared/themes";

/** Themes for app-level defaults: personal packages plus every known dashboard's. */
export async function loadApplicationThemes(
  registered: readonly ProjectListItem[],
  active: Pick<ProjectSnapshot, "configPath" | "dashboardName">,
): Promise<ThemeCatalogItem[]> {
  const candidates = new Map<string, { configPath: string; label?: string | null }>();
  for (const project of registered) candidates.set(project.configPath, { configPath: project.configPath, label: project.dashboardName });
  if (active.configPath) {
    candidates.set(active.configPath, { configPath: active.configPath, label: active.dashboardName });
  }
  const sources = (await Promise.all([...candidates.values()].map(async (candidate) => {
    try {
      const location = await resolveProjectLocation(candidate.configPath);
      return { ...candidate, configDirectory: location.configDirectory };
    } catch {
      return null;
    }
  }))).filter((source): source is NonNullable<typeof source> => source !== null);
  return loadApplicationThemeCatalog(sources);
}

/** Calls `onChange` (debounced) when a personal theme package changes on disk. */
export async function watchPersonalThemes(onChange: () => void): Promise<void> {
  try {
    await mkdir(personalThemesDirectory(), { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(personalThemesDirectory(), { recursive: true }, (_event, filename) => {
      if (filename && String(filename).split(/[\\/]/).some((part) => part === ".git" || isPackageWorkPath(part))) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
    watcher.on("error", (error) => console.error("Personal theme watcher unavailable; reload to refresh themes.", error));
  } catch (error) {
    console.error("Personal theme watcher unavailable; reload to refresh themes.", error);
  }
}
