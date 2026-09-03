import type {
  ComponentCatalogItem,
  ComponentManifest,
  Permission,
} from "../../shared/contracts";
import { PERMISSION_LABELS } from "./action-providers";

export type ComponentPermissionLabels = Readonly<Partial<Record<Permission, string>>>;

export interface ComponentCatalogParity {
  total: number;
  withManifest: number;
  unavailable: number;
  packaged: number;
  projectLocal: number;
  external: number;
  dashboardLinks: number;
  manifestShaped: number;
  contractSummaries: number;
  equivalentManifestShape: boolean;
}

/** Bundle-relative prefix for git-submodule external components (see shared contract). */
export const EXTERNAL_COMPONENT_PREFIX = "./components/external/";

/**
 * Pinned external-component details. Core discovery does not exist in every
 * checkout yet, so this is read defensively from stub catalog items whose
 * `source` is cast to `"external"` (see `externalComponentInfo`).
 */
export interface ExternalComponentInfo {
  /** Directory name below `components/external/`. */
  name: string;
  url: string;
  /** Full pinned commit SHA (may be empty when uninitialized). */
  commit: string;
  /** Bundle-relative path, e.g. `components/external/<name>`. */
  path: string;
  updateAvailable: boolean;
  initialized: boolean;
}

type AnyCatalogItem = Pick<ComponentCatalogItem, "reference" | "manifest" | "diagnostics"> & {
  source: string;
  external?: {
    url?: unknown;
    commit?: unknown;
    pin?: unknown;
    sha?: unknown;
    path?: unknown;
    updateAvailable?: unknown;
    initialized?: unknown;
  } | null;
  url?: unknown;
  commit?: unknown;
  pin?: unknown;
  path?: unknown;
  updateAvailable?: unknown;
  initialized?: unknown;
};

function asAnyItem(item: Pick<ComponentCatalogItem, "reference" | "manifest" | "diagnostics" | "source">): AnyCatalogItem {
  return item as unknown as AnyCatalogItem;
}

/** True for stub or core-provided external (git-submodule) catalog entries. */
export function isExternalCatalogItem(
  item: Pick<ComponentCatalogItem, "source"> | { source: string },
): boolean {
  return (item as { source: string }).source === "external";
}

/** Directory name below `components/external/`, falling back to the manifest id. */
export function externalComponentName(
  item: Pick<ComponentCatalogItem, "reference" | "manifest">,
): string {
  const reference = item.reference;
  if (reference.startsWith(EXTERNAL_COMPONENT_PREFIX)) {
    const rest = reference.slice(EXTERNAL_COMPONENT_PREFIX.length).split("/")[0] ?? "";
    if (rest.trim().length > 0) return rest;
  }
  return item.manifest?.id ?? reference;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Best-effort pin details for an external catalog entry; null for non-externals. */
export function externalComponentInfo(
  item: Pick<ComponentCatalogItem, "reference" | "manifest" | "source" | "available">,
): ExternalComponentInfo | null {
  if (!isExternalCatalogItem(item)) return null;
  const anyItem = asAnyItem(item as ComponentCatalogItem);
  const nested = anyItem.external ?? null;
  const name = externalComponentName(item);
  const url = textField(nested?.url ?? anyItem.url);
  const commit = textField(
    nested?.commit ?? nested?.pin ?? nested?.sha ?? anyItem.commit ?? anyItem.pin,
  );
  const path = textField(nested?.path ?? anyItem.path)
    || (name ? `components/external/${name}` : "");
  const updateAvailable = (nested?.updateAvailable ?? anyItem.updateAvailable) === true;
  // Core discovery carries the pin in the lock file, not on the catalog item:
  // an available entry with a manifest counts as initialized unless a stub or
  // core explicitly marks it otherwise. Uninitialized checkouts arrive as
  // unavailable with a COMPONENT_EXTERNAL_UNINITIALIZED diagnostic.
  const available = (item as { available?: unknown }).available !== false;
  const explicit = nested?.initialized ?? anyItem.initialized;
  const initialized = explicit !== false
    && (commit.length > 0 || (available && item.manifest !== null));
  return { name, url, commit, path, updateAvailable, initialized };
}

/** Short display form of a pinned commit SHA. */
export function shortExternalPin(commit: string): string {
  const trimmed = commit.trim();
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
}

function externalSearchText(
  item: Pick<ComponentCatalogItem, "reference" | "manifest" | "source" | "available">,
): string {
  const info = externalComponentInfo(item);
  if (!info) return "";
  return [info.url, info.commit, info.path, info.name].join(" ");
}

function normalized(value: string): string {
  return value.toLocaleLowerCase();
}

function manifestSearchText(manifest: ComponentManifest | null): string {
  if (!manifest) return "";
  return [
    manifest.id,
    manifest.name,
    manifest.description,
    manifest.renderMode ?? "surface",
    componentContractLabel({ manifest }),
    ...(manifest.permissions ?? []).flatMap((permission) => [permission, PERMISSION_LABELS[permission]]),
  ].join(" ");
}

/** Filter without reordering or hiding unavailable catalog diagnostics. */
export function filterComponentCatalog(
  catalog: readonly ComponentCatalogItem[],
  query: string,
): ComponentCatalogItem[] {
  const needle = normalized(query.trim());
  if (!needle) return [...catalog];
  return catalog.filter((item) => {
    const diagnostics = item.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    return normalized(`${item.reference} ${componentProvenanceLabel(item)} ${manifestSearchText(item.manifest)} ${externalSearchText(item)} ${diagnostics}`)
      .includes(needle);
  });
}

function manifestShape(manifest: ComponentManifest): string {
  const fields = [
    "schemaVersion",
    "id",
    "name",
    "description",
    "entry",
    "renderMode",
    "propsSchema",
    "children",
    "resources",
    "references",
    "permissions",
  ];
  const children = manifest.children;
  return JSON.stringify({
    fields,
    children: children
      ? {
          fields: ["min", "max", "presentation", "metadataSchema"],
          presentation: children.presentation.type,
          axes: children.presentation.type === "tiled" ? children.presentation.axes : undefined,
          hasMetadataSchema: children.metadataSchema !== undefined,
        }
      : null,
  });
}

/** Summarize catalog shape independently of whether an entry is packaged or local. */
export function componentCatalogParity(
  catalog: readonly ComponentCatalogItem[],
): ComponentCatalogParity {
  const manifests = catalog.flatMap((item) => item.manifest ? [item.manifest] : []);
  const shapes = new Set(manifests.map(manifestShape));
  const packaged = catalog.filter((item) => item.source === "builtin").length;
  const projectLocal = catalog.filter((item) => item.source === "local").length;
  const external = catalog.filter((item) => isExternalCatalogItem(item)).length;
  const dashboardLinks = catalog.filter((item) => item.source === "config").length;

  return {
    total: catalog.length,
    withManifest: manifests.length,
    unavailable: catalog.filter((item) => !item.available).length,
    packaged,
    projectLocal,
    external,
    dashboardLinks,
    manifestShaped: manifests.length,
    contractSummaries: new Set(manifests.map((manifest) => componentContractLabel({ manifest }))).size,
    equivalentManifestShape: manifests.length === 0 || shapes.size === 1,
  };
}

/** Describe the generic child contract exposed by a manifest. */
export function componentContractLabel(item: Pick<ComponentCatalogItem, "manifest">): string {
  const children = item.manifest?.children;
  if (!children) return "no children";

  const maximum = children.max === undefined ? "unlimited" : String(children.max);
  const presentation = children.presentation.type === "managed"
    ? "managed"
    : `tiled ${children.presentation.axes}`;
  return `min ${children.min}, max ${maximum} · ${presentation}`;
}

/** Resolve only permissions declared by the manifest, preserving declaration order. */
export function componentPermissionLabels(
  item: Pick<ComponentCatalogItem, "manifest">,
  labels: ComponentPermissionLabels,
): string[] {
  return (item.manifest?.permissions ?? []).flatMap((permission) => {
    const label = labels[permission];
    return label === undefined ? [] : [label];
  });
}

export function componentProvenanceLabel(
  item: Pick<ComponentCatalogItem, "source"> | { source: string },
): "Packaged" | "Project-local" | "Dashboard link" | "External" {
  const source = (item as { source: string }).source;
  if (source === "builtin") return "Packaged";
  if (source === "local") return "Project-local";
  if (source === "external") return "External";
  return "Dashboard link";
}

/** Split a catalog into internal entries and external (git-submodule) entries. */
export function partitionCatalogByExternal<T extends Pick<ComponentCatalogItem, "source">>(
  catalog: readonly T[],
): { internal: T[]; external: T[] } {
  const internal: T[] = [];
  const external: T[] = [];
  for (const item of catalog) {
    (isExternalCatalogItem(item) ? external : internal).push(item);
  }
  return { internal, external };
}

export interface ExternalAddInput {
  url: string;
  name?: string;
  ref?: string;
}

export interface ExternalInputErrors {
  url?: string;
  name?: string;
  ref?: string;
}

function isHttpGitUrl(value: string): boolean {
  if (!/^https?:\/\/.+\..+/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isScpGitUrl(value: string): boolean {
  return /^[\w.-]+@[\w.-]+:.+\/.+/.test(value);
}

function isFileGitUrl(value: string): boolean {
  return value.startsWith("file://") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

/** Validate the add-external dialog fields without touching git or the draft. */
export function validateExternalComponentInput(input: ExternalAddInput): {
  ok: boolean;
  errors: ExternalInputErrors;
} {
  const errors: ExternalInputErrors = {};
  const url = input.url.trim();
  if (url.length === 0) {
    errors.url = "Enter the component repository URL.";
  } else if (!isHttpGitUrl(url) && !isScpGitUrl(url) && !isFileGitUrl(url)) {
    errors.url = "Enter a valid git URL (https://, git@host:, or a local path).";
  }
  const name = (input.name ?? "").trim();
  if (name.length > 0 && !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    errors.name = "Use letters, digits, dot, dash, or underscore, starting with a letter or digit.";
  }
  if (name.length > 100) {
    errors.name = "Keep the name under 100 characters.";
  }
  const ref = (input.ref ?? "").trim();
  if (ref.length > 0 && /[\s~^:?*[\]\\]/.test(ref)) {
    errors.ref = "The ref contains characters git does not allow.";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** POSIX-quote one CLI argument only when it needs quoting. */
export function quoteExternalArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && value.length > 0) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Exact `dash-bored component add` command previewed by the add dialog. */
export function buildExternalAddCommand(input: ExternalAddInput): string {
  const parts = ["dash-bored", "component", "add", quoteExternalArg(input.url.trim())];
  const name = (input.name ?? "").trim();
  const ref = (input.ref ?? "").trim();
  if (name.length > 0) parts.push("--name", quoteExternalArg(name));
  if (ref.length > 0) parts.push("--ref", quoteExternalArg(ref));
  return parts.join(" ");
}

/** Exact `dash-bored component update` command previewed by the update confirm. */
export function buildExternalUpdateCommand(name: string, to?: string): string {
  const parts = ["dash-bored", "component", "update", quoteExternalArg(name.trim())];
  const target = (to ?? "").trim();
  if (target.length > 0) parts.push("--to", quoteExternalArg(target));
  return parts.join(" ");
}

/** Exact `dash-bored component remove` command previewed by the remove confirm. */
export function buildExternalRemoveCommand(name: string): string {
  return ["dash-bored", "component", "remove", quoteExternalArg(name.trim())].join(" ");
}

/** Exact `dash-bored component sync` command shown for uninitialized checkouts. */
export function buildExternalSyncCommand(): string {
  return "dash-bored component sync";
}
