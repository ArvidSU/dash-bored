import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { childEdges } from "../shared/child-edges";
import type { ResolvedComponentNode } from "../shared/contracts";
import { loadProjectDefinition } from "../core/project";
import { resolveProjectLocation } from "../core/paths";
import { readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import type { DashboardMigration, ReleaseMetadata } from "../shared/updates";

type Compatibility = { manifests: NonNullable<DashboardMigration["componentApi"]>["manifests"]; unavailable: boolean };
const compatibilityCache = new Map<string, { expires: number; stamps: [string, string][]; value: Compatibility }>();
const COMPATIBILITY_TTL_MS = 30_000;
const MAX_COMPATIBILITY_CACHE_ENTRIES = 32;

/** Durable migration decisions always request a fresh inspection. Polls reuse file-stamped results. */
export function invalidateMigrationInspection(configPath: string): void {
  for (const key of compatibilityCache.keys()) if (JSON.parse(key)[0] === configPath) compatibilityCache.delete(key);
}
async function fileStamp(path: string): Promise<string> {
  try { const value = await stat(path); return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`; }
  catch (error) { return `missing:${(error as NodeJS.ErrnoException).code}`; }
}
async function inspectComponentCompatibility(configPath: string, versions: string[], revision: string, fresh: boolean): Promise<Compatibility> {
  const key = JSON.stringify([configPath, versions, revision]);
  const cached = compatibilityCache.get(key);
  if (!fresh && cached && cached.expires > Date.now()
    && (await Promise.all(cached.stamps.map(async ([path, stamp]) => await fileStamp(path) === stamp))).every(Boolean)) return structuredClone(cached.value);
  const location = await resolveProjectLocation(configPath);
  const definition = await loadProjectDefinition(location, { compile: false });
  const files = new Set(definition.localComponents.map(component => component.manifestPath));
  const tracked = new Set([location.configPath, location.lockPath, location.componentsDirectory]);
  let unavailable = false;
  for (const item of definition.diagnostics) {
    if (item.file) tracked.add(item.file);
    if (item.path?.startsWith("./components/")) {
      const path = join(location.configDirectory, item.path);
      tracked.add(path); tracked.add(dirname(path));
    }
    if (["COMPONENT_API_UNSUPPORTED", "COMPONENT_API_REQUIRED", "MANIFEST_SCHEMA_MIGRATION_REQUIRED"].includes(item.code) && item.file) files.add(item.file);
    if (["COMPONENT_EXTERNAL_UNINITIALIZED", "COMPONENT_EXTERNAL_NO_MANIFEST", "COMPONENT_LOAD_FAILED", "COMPONENT_RESOLVE_FAILED", "PATH_NOT_FOUND"].includes(item.code)) unavailable = true;
  }
  const trackNode = (node: ResolvedComponentNode): void => {
    for (const path of [node.sourceConfigPath, node.configPath]) if (path) { tracked.add(path); tracked.add(join(dirname(path), "dash-bored-lock.yaml")); }
    for (const edge of childEdges(node.children)) trackNode(edge.node);
  };
  if (definition.tree) trackNode(definition.tree);
  const manifests: Compatibility["manifests"] = [];
  for (const path of files) {
    tracked.add(path); tracked.add(dirname(path));
    const text = await readFile(path, "utf8");
    if (text.length > 1_000_000) throw new Error("Component manifest is too large to inspect.");
    const manifest = parse(text, { maxAliasCount: 100 });
    const version = typeof manifest?.apiVersion === "string" ? manifest.apiVersion : null;
    if (version === null || !versions.includes(version) || manifest.schemaVersion !== 3) manifests.push({ path, version });
  }
  const value = { manifests, unavailable };
  const stamps = await Promise.all([...tracked].map(async path => [path, await fileStamp(path)] as [string, string]));
  // Remove older revisions for this dashboard before enforcing the global bound.
  invalidateMigrationInspection(configPath);
  if (compatibilityCache.size >= MAX_COMPATIBILITY_CACHE_ENTRIES) compatibilityCache.delete(compatibilityCache.keys().next().value!);
  compatibilityCache.set(key, { expires: Date.now() + COMPATIBILITY_TTL_MS, stamps, value: structuredClone(value) });
  return value;
}

export async function inspectMigration(configPath: string, release: Pick<ReleaseMetadata, "minimumContract" | "dashboardContract" | "recipes" | "componentApiVersions">, options: { fresh?: boolean } = {}): Promise<DashboardMigration> {
  let contract: number | null = null;
  let revision = "";
  try {
    const text = await readFile(configPath, "utf8");
    if (text.length > 1_000_000) throw new Error("Dashboard is too large to inspect.");
    revision = createHash("sha256").update(text).digest("hex");
    const doc = parse(text, { maxAliasCount: 100 });
    if (Number.isSafeInteger(doc?.schemaVersion)) contract = doc.schemaVersion;
  } catch (error) {
    return { configPath, contract, status: "unsupported", steps: [], message: `Cannot determine dashboard contract: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (contract === null || contract < release.minimumContract || contract > release.dashboardContract) return { configPath, contract, status: "unsupported", steps: [], message: `Contract ${contract ?? "unknown"} has no supported migration path. Historical v1-to-v2 conversion is not provided.` };
  const steps = release.recipes.filter(r => r.from >= contract! && r.to <= release.dashboardContract).sort((a, b) => a.from - b.from);
  let componentApi: DashboardMigration["componentApi"];
  let unavailable = false;
  if (release.componentApiVersions?.length) {
    const manifests: NonNullable<DashboardMigration["componentApi"]>["manifests"] = [];
    if (contract === release.dashboardContract) {
      try {
        const compatibility = await inspectComponentCompatibility(configPath, release.componentApiVersions, revision, options.fresh === true);
        manifests.push(...compatibility.manifests);
        unavailable = compatibility.unavailable;
      } catch (error) {
        return { configPath, contract, status: "unsupported", steps, message: `Cannot inspect component compatibility: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (steps.length || manifests.length || unavailable) componentApi = {
      supportedVersions: [...release.componentApiVersions], manifests,
      instructions: `Target component APIs: ${release.componentApiVersions.join(", ")}. Inspect the selected bundle's used components with the target CLI and resolve all unsupported APIs and missing packages. Migrate project-owned component implementations and their SDK declarations before changing apiVersion; do not merely relabel a manifest. For incompatible external packages, inspect the package's migration guidance and choose an API-compatible published revision, updating only that package's exact lock pin. Restore missing checkouts from their existing pins first. Preserve unrelated pins, URLs, paths and files. Do not edit external checkout source or any linked dashboard bundle; report linked-bundle incompatibilities for separate selection. Validate the selected dashboard with the target CLI.`,
    };
  }
  const required = steps.length > 0 || componentApi !== undefined;
  return { configPath, contract, status: required ? "required" : "current", steps,
    ...(componentApi ? { componentApi } : {}),
    message: required ? [...steps.map(r => r.title), ...(componentApi ? ["Review component API compatibility"] : [])].join("; ") : "No dashboard migration required." };
}
