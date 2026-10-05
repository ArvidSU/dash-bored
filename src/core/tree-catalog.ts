import { basename, dirname, relative, resolve, sep } from "node:path";
import { readdir } from "node:fs/promises";
import type { ComponentCatalogItem, ComponentManifest, Diagnostic } from "../shared/contracts";
import { diagnostic, errorMessage } from "./diagnostics";
import { isPathContained, resolveContainedPath, type ProjectLocation } from "./paths";
import { parseComponentManifest } from "./yaml";

const MAX_CATALOG_DIRECTORIES = 1_000;
const MAX_CATALOG_DEPTH = 16;
export const LOCAL_REFERENCE_PREFIX = "./components/";
const EXTERNAL_REFERENCE_PREFIX = "./components/external/";

export const EXTERNAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The pinned submodule name for any reference below `./components/external/`, or null. */
export function externalComponentNameFromReference(reference: string): string | null {
  if (!reference.startsWith(EXTERNAL_REFERENCE_PREFIX)) return null;
  const rest = reference.slice(EXTERNAL_REFERENCE_PREFIX.length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  if (name.length === 0 || !EXTERNAL_NAME_PATTERN.test(name)) return null;
  if (slash !== -1 && rest.slice(slash + 1).split("/").some((segment) => segment.length === 0)) {
    return null;
  }
  return name;
}

export function isExternalReference(reference: string): boolean {
  return externalComponentNameFromReference(reference) !== null;
}

/** Only the submodule root itself (`./components/external/<name>`), not nested paths below it. */
export function isExternalRootReference(reference: string): boolean {
  const name = externalComponentNameFromReference(reference);
  return name !== null && reference === `${EXTERNAL_REFERENCE_PREFIX}${name}`;
}

export interface LocalComponentDefinition {
  reference: string;
  directory: string;
  manifestPath: string;
  entryPath: string;
  manifest: ComponentManifest;
}

export function isLocalReference(reference: string): boolean {
  return reference.startsWith(LOCAL_REFERENCE_PREFIX) && reference.length > LOCAL_REFERENCE_PREFIX.length;
}

export function localReferenceFromDirectory(componentsDirectory: string, componentDirectory: string): string {
  const value = relative(componentsDirectory, componentDirectory).split(sep).join("/");
  return `${LOCAL_REFERENCE_PREFIX}${value}`;
}

export function componentDirectoryFromReference(componentsDirectory: string, reference: string): string | null {
  if (!isLocalReference(reference)) return null;
  const value = resolve(componentsDirectory, reference.slice(LOCAL_REFERENCE_PREFIX.length));
  return isPathContained(componentsDirectory, value) ? value : null;
}

export function componentDisplayName(definition: LocalComponentDefinition): string {
  return definition.manifest.name || basename(dirname(definition.manifestPath));
}

export async function discoverComponentCatalog(
  location: ProjectLocation,
): Promise<ComponentCatalogItem[]> {
  const catalog: ComponentCatalogItem[] = [];
  let visited = 0;

  interface CatalogEntryLike {
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  }

  const visitChildDirectories = async (
    childEntries: readonly CatalogEntryLike[],
    directory: string,
    depth: number,
  ): Promise<boolean> => {
    const found = await Promise.all(
      childEntries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git")
        .map((entry) => visit(resolve(directory, entry.name), depth + 1)),
    );
    return found.some(Boolean);
  };

  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > MAX_CATALOG_DEPTH || visited >= MAX_CATALOG_DIRECTORIES) return false;
    visited += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === location.componentsDirectory) {
        catalog.push({
          reference: "./components",
          source: "local",
          available: false,
          manifest: null,
          diagnostics: [
            diagnostic({
              code: "COMPONENT_CATALOG_READ_FAILED",
              message: errorMessage(error),
              path: directory,
            }),
          ],
        });
      }
      return false;
    }

    const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "component.yaml");
    if (manifestEntry) {
      const reference = localReferenceFromDirectory(location.componentsDirectory, directory);
      const loaded = await loadLocalDefinition(location, reference);
      const containmentDiagnostics = loaded.definition
        ? validateLocalDefinitionContainment(loaded.definition)
        : [];
      const diagnostics = [...loaded.diagnostics, ...containmentDiagnostics];
      catalog.push({
        reference,
        source: isExternalReference(reference) ? "external" : "local",
        available: loaded.definition !== null && diagnostics.length === 0,
        manifest: loaded.definition?.manifest ?? null,
        diagnostics,
      });
      return true;
    }

    // An external component directory is a submodule checkout. Only an
    // actually empty directory means syncing external components can help.
    // An initialized checkout without a root manifest may still hold
    // components deeper inside (monorepo-style repos), so descend first and
    // report a distinct diagnostic only when nothing resolves below it.
    const externalReference = localReferenceFromDirectory(location.componentsDirectory, directory);
    if (
      directory !== location.componentsDirectory &&
      isExternalRootReference(externalReference)
    ) {
      if (entries.length === 0) {
        catalog.push({
          reference: externalReference,
          source: "external",
          available: false,
          manifest: null,
          diagnostics: [
            diagnostic({
              code: "COMPONENT_EXTERNAL_UNINITIALIZED",
              message: `External component ${externalReference} is not initialized. Sync external components from the component library.`,
              path: externalReference,
            }),
          ],
        });
        return false;
      }
      const found = await visitChildDirectories(entries, directory, depth);
      if (!found) {
        catalog.push({
          reference: externalReference,
          source: "external",
          available: false,
          manifest: null,
          diagnostics: [
            diagnostic({
              code: "COMPONENT_EXTERNAL_NO_MANIFEST",
              message: `External component ${externalReference} is checked out but contains no component.yaml.`,
              path: externalReference,
            }),
          ],
        });
      }
      return found;
    }

    return visitChildDirectories(entries, directory, depth);
  };

  await visit(location.componentsDirectory, 0);

  const localById = new Map<string, ComponentCatalogItem[]>();
  for (const item of catalog) {
    if (item.manifest === null) continue;
    const matches = localById.get(item.manifest.id) ?? [];
    matches.push(item);
    localById.set(item.manifest.id, matches);
  }
  for (const [id, matches] of localById) {
    if (matches.length < 2) continue;
    for (const item of matches) {
      item.available = false;
      item.diagnostics.push(
        diagnostic({
          code: "COMPONENT_ID_DUPLICATE",
          message: `Component id ${id} is declared by more than one local component.`,
          path: item.reference,
        }),
      );
    }
  }

  return catalog.sort((left, right) => {
    if (left.source !== right.source) return left.source.localeCompare(right.source);
    return left.reference.localeCompare(right.reference);
  });
}

export async function loadLocalDefinition(
  location: ProjectLocation,
  reference: string,
): Promise<{ definition: LocalComponentDefinition | null; diagnostics: Diagnostic[] }> {
  if (!isLocalReference(reference)) {
    return {
      definition: null,
      diagnostics: [
        diagnostic({
          code: reference.startsWith("@dash-bored/")
            ? "BUILTIN_COMPONENT_UNKNOWN"
            : "COMPONENT_SOURCE_UNSUPPORTED",
          message: reference.startsWith("@dash-bored/")
            ? `Unknown built-in component: ${reference}`
            : `Use a ${LOCAL_REFERENCE_PREFIX} component path, including external packages.`,
          path: reference,
        }),
      ],
    };
  }

  const relativeDirectory = reference.slice(LOCAL_REFERENCE_PREFIX.length);
  try {
    const directory = await resolveContainedPath(
      location.componentsDirectory,
      relativeDirectory,
      { kind: "directory" },
    );
    const manifestPath = await resolveContainedPath(directory, "component.yaml", { kind: "file" });
    const parsed = await parseComponentManifest(manifestPath);
    if (parsed.value === null) return { definition: null, diagnostics: parsed.diagnostics };
    if (parsed.value.id.startsWith("@dash-bored/")) {
      return {
        definition: null,
        diagnostics: [
          diagnostic({
            code: "COMPONENT_ID_RESERVED",
            message: "The @dash-bored/* component id namespace is reserved for legacy dashboard references; use an ordinary component ID.",
            file: manifestPath,
            path: "/id",
          }),
        ],
      };
    }

    const entryPath = await resolveContainedPath(directory, parsed.value.entry, { kind: "file" });
    const extension = entryPath.slice(entryPath.lastIndexOf(".")).toLowerCase();
    if (extension !== ".ts" && extension !== ".tsx") {
      return {
        definition: null,
        diagnostics: [
          diagnostic({
            code: "COMPONENT_ENTRY_UNSUPPORTED",
            message: "Local component entrypoints must be .ts or .tsx files.",
            file: manifestPath,
            path: "/entry",
          }),
        ],
      };
    }

    return {
      definition: {
        reference,
        directory,
        manifestPath,
        entryPath,
        manifest: parsed.value,
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      definition: null,
      diagnostics: [
        diagnostic({
          code: error instanceof Error && "code" in error ? String(error.code) : "COMPONENT_RESOLVE_FAILED",
          message: errorMessage(error),
          path: reference,
        }),
      ],
    };
  }
}

export function validateLocalDefinitionContainment(definition: LocalComponentDefinition): Diagnostic[] {
  if (!isPathContained(definition.directory, definition.entryPath)) {
    return [
      diagnostic({
        code: "PATH_OUTSIDE_COMPONENT",
        message: "The component entrypoint resolves outside its component directory.",
        file: definition.manifestPath,
        path: "/entry",
      }),
    ];
  }
  return [];
}
