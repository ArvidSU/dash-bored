import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import { CONFIG_DIRECTORY, CONFIG_FILE } from "../shared/contracts";

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

function dashboardKey(item: Pick<ProjectListItem, "configPath">): string {
  return item.configPath;
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

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, projects: this.projects }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.path);
  }

  private load(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        const candidate = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredProjectRegistry>;
        if (candidate.version !== 1 || !Array.isArray(candidate.projects)) return;
        const seen = new Set<string>();
        this.projects = candidate.projects.flatMap((item) => {
          const parsed = parseProjectListItem(item);
          if (parsed === null || seen.has(dashboardKey(parsed))) return [];
          seen.add(dashboardKey(parsed));
          return [parsed];
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A corrupt registry must not prevent the application from opening.
          this.projects = [];
        }
      }
    })();
    return this.loadPromise;
  }

  async list(): Promise<ProjectListItem[]> {
    await this.load();
    await this.writeQueue;
    return structuredClone(this.projects);
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
      const existingIndex = this.projects.findIndex(
        (project) => dashboardKey(project) === dashboardKey(item),
      );
      if (
        existingIndex !== -1 &&
        this.projects[existingIndex]?.dashboardName === item.dashboardName &&
        this.projects[existingIndex]?.iconDataUrl === item.iconDataUrl
      ) {
        return;
      }
      const previous = existingIndex === -1 ? undefined : this.projects[existingIndex];
      if (existingIndex === -1) this.projects.push(item);
      else this.projects[existingIndex] = item;
      try {
        await this.persist();
      } catch (error) {
        if (existingIndex === -1) this.projects.pop();
        else if (previous !== undefined) this.projects[existingIndex] = previous;
        throw error;
      }
    });
  }

  async remove(projectRoot: string, configPath = canonicalConfigPath(projectRoot)): Promise<ProjectListItem | null> {
    await this.load();
    return this.enqueueWrite(async () => {
      const index = this.projects.findIndex(
        (project) => project.projectRoot === projectRoot && project.configPath === configPath,
      );
      if (index === -1) return null;
      const [removed] = this.projects.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        if (removed !== undefined) this.projects.splice(index, 0, removed);
        throw error;
      }
      return removed ? structuredClone(removed) : null;
    });
  }

  async restore(project: ProjectListItem): Promise<void> {
    await this.load();
    await this.enqueueWrite(async () => {
      const index = this.projects.findIndex(
        (candidate) => dashboardKey(candidate) === dashboardKey(project),
      );
      const previous = index === -1 ? undefined : this.projects[index];
      const restored = structuredClone(project);
      if (index === -1) this.projects.push(restored);
      else this.projects[index] = restored;
      try {
        await this.persist();
      } catch (error) {
        if (index === -1) this.projects.pop();
        else if (previous !== undefined) this.projects[index] = previous;
        throw error;
      }
    });
  }
}
