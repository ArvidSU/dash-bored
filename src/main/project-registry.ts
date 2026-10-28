import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import { CONFIG_DIRECTORY, CONFIG_FILE } from "../shared/contracts";
import { atomicJson } from "../core/fs-atomic";

interface StoredProjectRegistry {
  version: 1;
  projects: ProjectListItem[];
}

function canonicalConfigPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIRECTORY, CONFIG_FILE);
}

function parseProjectListItem(value: unknown): ProjectListItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.projectRoot !== "string" ||
    !isAbsolute(item.projectRoot) ||
    (typeof item.dashboardName !== "string" && item.dashboardName !== null) ||
    (item.iconDataUrl !== undefined && item.iconDataUrl !== null && typeof item.iconDataUrl !== "string")
  ) return null;
  const configPath = item.configPath === undefined
    ? canonicalConfigPath(item.projectRoot)
    : item.configPath;
  if (typeof configPath !== "string" || !isAbsolute(configPath)) return null;
  return {
    projectRoot: item.projectRoot,
    configPath,
    dashboardName: item.dashboardName,
    ...(item.iconDataUrl === undefined ? {} : { iconDataUrl: item.iconDataUrl }),
  };
}

export class ProjectRegistry {
  private projects: ProjectListItem[] = [];
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Persist `next`, keeping the previous list when the write fails. */
  private async commit(next: ProjectListItem[]): Promise<void> {
    const previous = this.projects;
    this.projects = next;
    try {
      await atomicJson(this.path, { version: 1, projects: next });
    } catch (error) {
      this.projects = previous;
      throw error;
    }
  }

  /** Insert `item` or replace the entry for the same dashboard. */
  private upserted(item: ProjectListItem): ProjectListItem[] {
    const index = this.projects.findIndex((project) => project.configPath === item.configPath);
    return index === -1 ? [...this.projects, item] : this.projects.map((project, i) => (i === index ? item : project));
  }

  private load(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        const candidate = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredProjectRegistry>;
        if (candidate.version !== 1 || !Array.isArray(candidate.projects)) return;
        const seen = new Set<string>();
        this.projects = candidate.projects.flatMap((item) => {
          const parsed = parseProjectListItem(item);
          if (parsed === null || seen.has(parsed.configPath)) return [];
          seen.add(parsed.configPath);
          return [parsed];
        });
      } catch {
        // A missing or corrupt registry must not prevent the application from opening.
      }
    })();
    return this.loadPromise;
  }

  async list(): Promise<ProjectListItem[]> {
    await this.load();
    await this.writeQueue;
    return structuredClone(this.projects);
  }

  /** Move only registered dashboards; stale drag targets cannot add or remove entries. */
  async move(configPath: string, targetConfigPath: string, before: boolean): Promise<ProjectListItem[]> {
    await this.load();
    return this.enqueueWrite(async () => {
      const previous = this.projects;
      const source = previous.find((project) => project.configPath === configPath);
      if (!source || configPath === targetConfigPath || !previous.some((project) => project.configPath === targetConfigPath)) {
        return structuredClone(previous);
      }
      const next = previous.filter((project) => project !== source);
      const targetIndex = next.findIndex((project) => project.configPath === targetConfigPath);
      next.splice(targetIndex + (before ? 0 : 1), 0, source);
      await this.commit(next);
      return structuredClone(next);
    });
  }

  async contains(projectRoot: string, configPath = canonicalConfigPath(projectRoot)): Promise<boolean> {
    await this.load();
    await this.writeQueue;
    return this.projects.some(
      (project) => project.projectRoot === projectRoot && project.configPath === configPath,
    );
  }

  async remember(snapshot: ProjectSnapshot): Promise<void> {
    if (snapshot.projectRoot === null) return;
    await this.load();
    const item: ProjectListItem = {
      projectRoot: snapshot.projectRoot,
      configPath: snapshot.configPath ?? canonicalConfigPath(snapshot.projectRoot),
      dashboardName: snapshot.dashboardName,
      iconDataUrl: snapshot.iconDataUrl,
    };

    await this.enqueueWrite(async () => {
      const existing = this.projects.find((project) => project.configPath === item.configPath);
      if (existing && existing.dashboardName === item.dashboardName && existing.iconDataUrl === item.iconDataUrl) return;
      await this.commit(this.upserted(item));
    });
  }

  async remove(projectRoot: string, configPath = canonicalConfigPath(projectRoot)): Promise<ProjectListItem | null> {
    await this.load();
    return this.enqueueWrite(async () => {
      const index = this.projects.findIndex(
        (project) => project.projectRoot === projectRoot && project.configPath === configPath,
      );
      if (index === -1) return null;
      const removed = this.projects[index]!;
      await this.commit(this.projects.filter((_, i) => i !== index));
      return structuredClone(removed);
    });
  }

  async restore(project: ProjectListItem): Promise<void> {
    await this.load();
    await this.enqueueWrite(() => this.commit(this.upserted(structuredClone(project))));
  }
}
