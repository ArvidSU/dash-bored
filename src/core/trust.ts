import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Permission } from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";

interface TrustGrant {
  permissions: Permission[];
  trustedAt: string;
}

interface TrustFile {
  version: 1;
  projects: Record<string, TrustGrant>;
}

export interface TrustGrantSnapshot {
  projectRoot: string;
  permissions: Permission[];
  trustedAt: string;
}

function emptyTrustFile(): TrustFile {
  return { version: 1, projects: {} };
}

function isPermission(value: unknown): value is Permission {
  return value === "filesystem:read"
    || value === "filesystem:write"
    || value === "network:http"
    || value === "process:execute"
    || value === "process:observe"
    || value === "webview:embed";
}

function parseTrustFile(source: string): TrustFile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CoreError("TRUST_STORE_INVALID", `The trust store is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new CoreError("TRUST_STORE_INVALID", "The trust store root must be an object.");
  }
  const candidate = value as { version?: unknown; projects?: unknown };
  if (candidate.version !== 1 || typeof candidate.projects !== "object" || candidate.projects === null) {
    throw new CoreError("TRUST_STORE_INVALID", "The trust store has an unsupported structure or version.");
  }

  const projects: Record<string, TrustGrant> = {};
  for (const [projectRoot, grant] of Object.entries(candidate.projects)) {
    if (typeof grant !== "object" || grant === null) {
      throw new CoreError("TRUST_STORE_INVALID", `Invalid trust grant for ${projectRoot}.`);
    }
    const item = grant as { permissions?: unknown; trustedAt?: unknown };
    if (
      !Array.isArray(item.permissions) ||
      !item.permissions.every(isPermission) ||
      typeof item.trustedAt !== "string"
    ) {
      throw new CoreError("TRUST_STORE_INVALID", `Invalid trust grant for ${projectRoot}.`);
    }
    projects[projectRoot] = {
      permissions: [...new Set(item.permissions)].sort(),
      trustedAt: item.trustedAt,
    };
  }
  return { version: 1, projects };
}

async function canonicalRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(projectRoot);
    throw error;
  }
}

export class TrustStore {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (filePath.trim() === "") throw new CoreError("TRUST_STORE_PATH_EMPTY", "Trust store path is required.");
    this.filePath = resolve(filePath);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<TrustFile> {
    try {
      return parseTrustFile(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyTrustFile();
      throw error;
    }
  }

  private async write(value: TrustFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  async getGrant(projectRoot: string): Promise<TrustGrantSnapshot | null> {
    return this.serialize(async () => {
      const root = await canonicalRoot(projectRoot);
      const grant = (await this.read()).projects[root];
      return grant === undefined ? null : { projectRoot: root, ...grant };
    });
  }

  async isTrusted(projectRoot: string, requestedPermissions: readonly Permission[]): Promise<boolean> {
    const grant = await this.getGrant(projectRoot);
    if (grant === null) return false;
    const granted = new Set(grant.permissions);
    return requestedPermissions.every((permission) => granted.has(permission));
  }

  async trust(projectRoot: string, permissions: readonly Permission[]): Promise<TrustGrantSnapshot> {
    return this.serialize(async () => {
      const root = await canonicalRoot(projectRoot);
      const value = await this.read();
      const grant: TrustGrant = {
        permissions: [...new Set(permissions)].sort(),
        trustedAt: new Date().toISOString(),
      };
      value.projects[root] = grant;
      await this.write(value);
      return { projectRoot: root, ...grant };
    });
  }

  async revoke(projectRoot: string): Promise<boolean> {
    return this.serialize(async () => {
      const root = await canonicalRoot(projectRoot);
      const value = await this.read();
      if (value.projects[root] === undefined) return false;
      delete value.projects[root];
      await this.write(value);
      return true;
    });
  }
}
