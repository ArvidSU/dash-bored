import { execFileSync } from "node:child_process";
import { CORE_PACKAGE } from "../../src/shared/core-package";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import type { DashboardConfig, DashboardLock } from "../../src/shared/contracts";

export const defaultConfig: DashboardConfig = {
    schemaVersion: 4,
    name: "Test project",
    root: {
        component: "./components/external/core/group",
        children: {
            node: {
                component: "./components/external/core/markdown",
                props: { content: "# Ready" }
            }
        }
    }
};

export async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dash-bored-core-"));
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  if (!path.startsWith(join(tmpdir(), "dash-bored-core-"))) {
    throw new Error(`Refusing to remove unexpected test path: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

export async function createProject(
  root: string,
  config: DashboardConfig = defaultConfig,
  lock: DashboardLock = { lockfileVersion: 1, components: {} },
): Promise<void> {
  const directory = join(root, ".dash-bored");
  if (JSON.stringify(config).includes("./components/external/core/")) {
    lock = { ...lock, components: { ...lock.components, core: { ...CORE_PACKAGE } } };
    await installCoreFixture(directory);
  }
  await mkdir(join(directory, "components"), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "dash-bored.yaml"), stringify(config), "utf8"),
    writeFile(join(directory, "dash-bored-lock.yaml"), stringify(lock), "utf8"),
  ]);
}

export async function writeLocalComponent(
  root: string,
  name: string,
  source: string,
  options: {
    css?: string;
    permissions?: string[];
    resources?: Record<string, unknown>;
    references?: Record<string, unknown>;
    propsSchema?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const directory = join(root, ".dash-bored", "components", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "component.yaml"),
    stringify({
      schemaVersion: 3, apiVersion: "1.0.0",
      id: name,
      name,
      description: `${name} component`,
      entry: "./index.tsx",
      propsSchema: options.propsSchema ?? {
        type: "object",
        additionalProperties: false,
        properties: { message: { type: "string" } },
      },
      ...(options.resources === undefined ? {} : { resources: options.resources }),
      ...(options.references === undefined ? {} : { references: options.references }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    }),
    "utf8",
  );
  await writeFile(join(directory, "index.tsx"), source, "utf8");
  if (options.css !== undefined) await writeFile(join(directory, "style.css"), options.css, "utf8");
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Static fixtures contain the exact published output, with no network or built-in registry. */
export async function installCoreFixture(bundle: string): Promise<void> {
 await mkdir(join(bundle, "components", "external"), {recursive:true});
 const target = join(bundle,"components","external","core");
 if (!await Bun.file(join(target,"component.yaml")).exists() && !await Bun.file(join(target,"group","component.yaml")).exists()) {
  execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "--quiet", resolve(import.meta.dirname, "../../.dash-bored/components/external/core"), target]);
 }
}
