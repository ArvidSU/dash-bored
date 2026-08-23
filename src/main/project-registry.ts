import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";

interface StoredProjectRegistry {
  version: 1;
  projects: ProjectListItem[];
}

function isProjectListItem(value: unknown): value is ProjectListItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.projectRoot === "string" &&
    isAbsolute(item.projectRoot) &&
    (typeof item.dashboardName === "string" || item.dashboardName === null)
  );
}

export class ProjectRegistry {
  private projects: ProjectListItem[] = [];
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private load(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        const candidate = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredProjectRegistry>;
        if (candidate.version !== 1 || !Array.isArray(candidate.projects)) return;
        const seen = new Set<string>();
        this.projects = candidate.projects.filter((item): item is ProjectListItem => {
          if (!isProjectListItem(item) || seen.has(item.projectRoot)) return false;
          seen.add(item.projectRoot);
          return true;
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

  async contains(projectRoot: string): Promise<boolean> {
    await this.load();
    await this.writeQueue;
    return this.projects.some((project) => project.projectRoot === projectRoot);
  }

  async remember(snapshot: ProjectSnapshot): Promise<void> {
    if (snapshot.projectRoot === null) return;
    await this.load();
    const item: ProjectListItem = {
      projectRoot: snapshot.projectRoot,
      dashboardName: snapshot.dashboardName,
    };

    this.writeQueue = this.writeQueue.then(async () => {
      const existingIndex = this.projects.findIndex(
        (project) => project.projectRoot === item.projectRoot,
      );
      if (
        existingIndex !== -1 &&
        this.projects[existingIndex]?.dashboardName === item.dashboardName
      ) {
        return;
      }
      if (existingIndex === -1) this.projects.push(item);
      else this.projects[existingIndex] = item;

      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, projects: this.projects }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    });
    await this.writeQueue;
  }
}
