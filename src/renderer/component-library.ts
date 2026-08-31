import type {
  ComponentCatalogItem,
  ComponentManifest,
  Permission,
} from "../shared/contracts";
import { PERMISSION_LABELS } from "./action-providers";

export type ComponentPermissionLabels = Readonly<Partial<Record<Permission, string>>>;

export interface ComponentCatalogParity {
  total: number;
  withManifest: number;
  unavailable: number;
  packaged: number;
  projectLocal: number;
  dashboardLinks: number;
  manifestShaped: number;
  contractSummaries: number;
  equivalentManifestShape: boolean;
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
    return normalized(`${item.reference} ${componentProvenanceLabel(item)} ${manifestSearchText(item.manifest)} ${diagnostics}`)
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
  const dashboardLinks = catalog.filter((item) => item.source === "config").length;

  return {
    total: catalog.length,
    withManifest: manifests.length,
    unavailable: catalog.filter((item) => !item.available).length,
    packaged,
    projectLocal,
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
  item: Pick<ComponentCatalogItem, "source">,
): "Packaged" | "Project-local" | "Dashboard link" {
  if (item.source === "builtin") return "Packaged";
  if (item.source === "local") return "Project-local";
  return "Dashboard link";
}
