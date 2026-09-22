import type { ComponentManifest, Permission } from "./contracts";

/** Resolve static and prop-activated permissions from the same manifest contract. */
export function permissionsForComponent(
  manifest: Pick<ComponentManifest, "permissions" | "permissionsByProp"> | null | undefined,
  props: Record<string, unknown>,
): Permission[] {
  const permissions = new Set<Permission>(manifest?.permissions ?? []);
  for (const [path, required] of Object.entries(manifest?.permissionsByProp ?? {})) {
    const value = path.split(".").reduce<unknown>((current, part) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, props);
    if (value !== undefined && value !== null && value !== false) {
      for (const permission of required) permissions.add(permission);
    }
  }
  return [...permissions].sort();
}
