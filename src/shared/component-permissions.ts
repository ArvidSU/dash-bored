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

/**
 * A node's capability set: its component's permissions plus the composition's
 * own requests. A `watch` is YAML intent, never a manifest declaration, so it
 * adds `background:watch` to the node that carries it.
 */
export function permissionsForNode(
  manifest: Pick<ComponentManifest, "permissions" | "permissionsByProp"> | null | undefined,
  node: { props?: Record<string, unknown>; watch?: unknown },
): Permission[] {
  const permissions = permissionsForComponent(manifest, node.props ?? {});
  return node.watch === undefined ? permissions : [...new Set<Permission>([...permissions, "background:watch"])].sort();
}
