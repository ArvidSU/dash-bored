import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";
import type { ComponentTemplate } from "../shared/package-templates";
import type { DashboardConfig } from "../shared/contracts";
import { resolveContainedPath, type ProjectLocation } from "./paths";
import { validateDashboardConfigValue } from "./yaml";
import { CoreError } from "./diagnostics";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Substitute known string tokens only, preserving item references and shell syntax. */
function interpolate(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\$\{([^{}]+)\}/g, (token, key: string) => Object.hasOwn(variables, key) ? variables[key]! : token);
  if (Array.isArray(value)) return value.map((item) => interpolate(item, variables));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, variables)]));
  return value;
}

export async function loadPackageTemplates(
  directory: string,
  packageReference: string,
  variables: Record<string, string> = {},
): Promise<ComponentTemplate[]> {
  const descriptorPath = await resolveContainedPath(directory, "package.yaml", { mustExist: false });
  const text = await readFile(descriptorPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return [];
  const descriptor: unknown = parse(text);
  if (!record(descriptor) || descriptor.schemaVersion !== 1 || (descriptor.templates !== undefined && !Array.isArray(descriptor.templates))) {
    throw new CoreError("PACKAGE_TEMPLATE_INVALID", `Invalid package descriptor: ${descriptorPath}`);
  }
  const templates: ComponentTemplate[] = [];
  const ids = new Set<string>();
  for (const entry of (descriptor.templates ?? []) as unknown[]) {
    if (!record(entry) || typeof entry.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.path !== "string"
      || (entry.description !== undefined && typeof entry.description !== "string")
      || (entry.role !== undefined && entry.role !== "starter" && entry.role !== "tutorial")) {
      throw new CoreError("PACKAGE_TEMPLATE_INVALID", `Invalid or duplicate template in ${descriptorPath}`);
    }
    ids.add(entry.id);
    const file = await resolveContainedPath(directory, entry.path, { kind: "file" });
    const value = interpolate(parse(await readFile(file, "utf8")), { ...variables, package: packageReference });
    if (!record(value)) throw new CoreError("PACKAGE_TEMPLATE_INVALID", `Invalid template: ${file}`);
    const config = ("schemaVersion" in value ? value : { schemaVersion: 4, name: entry.name, root: value }) as unknown as DashboardConfig;
    const diagnostics = validateDashboardConfigValue(config, file);
    if (diagnostics.length) throw new CoreError("PACKAGE_TEMPLATE_INVALID", diagnostics.map((item) => item.message).join("; "));
    templates.push({ reference: `${packageReference}#${entry.id}`, id: entry.id, name: entry.name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.role ? { role: entry.role } : {}), root: config.root,
      ...("schemaVersion" in value ? { config } : {}),
    });
  }
  return templates;
}

/** Package metadata is inspected without executing package code. */
export async function discoverPackageTemplates(location: ProjectLocation): Promise<ComponentTemplate[]> {
  const templates: ComponentTemplate[] = [];
  let visited = 0;
  const variables = {
    projectName: basename(location.projectRoot),
    environmentPath: relative(location.projectRoot, join(location.configDirectory, ".env")).replaceAll("\\", "/"),
  };
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (++visited > 1000 || depth > 16) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.some((entry) => entry.name === "package.yaml" && entry.isFile())) {
      const reference = `./components/${relative(location.componentsDirectory, directory).replaceAll("\\", "/")}`;
      templates.push(...await loadPackageTemplates(directory, reference, variables));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !["node_modules", ".git", ".dash-bored-sdk"].includes(entry.name)) await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(location.componentsDirectory, 0);
  return templates.sort((left, right) => left.reference.localeCompare(right.reference));
}
