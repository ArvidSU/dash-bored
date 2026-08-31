import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { DashboardConfig, DashboardLock } from "../../src/shared/contracts";

export const defaultConfig: DashboardConfig = {
  schemaVersion: 2,
  name: "Test project",
  root: {
    component: "@dash-bored/group",
    children: {
      type: "tiled",
      layout: {
        type: "child",
        child: {
          node: {
            component: "@dash-bored/markdown",
            props: { content: "# Ready" },
          },
        },
      },
    },
  },
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
  const directory = join(root, "dash-bored");
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
  const directory = join(root, "dash-bored", "components", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "component.yaml"),
    stringify({
      schemaVersion: 2,
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
