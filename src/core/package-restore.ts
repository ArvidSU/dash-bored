import { childEdges } from "../shared/child-edges";
import type { Diagnostic, ComponentNode } from "../shared/contracts";
import { diagnostic, errorMessage } from "./diagnostics";
import { resolveProjectLocation } from "./paths";
import { parseDashboardConfig } from "./yaml";
import { isConfigReference, resolveConfigReferencePath } from "./tree-links";
import { syncComponents } from "./external-components";
import { syncThemes } from "./theme-install";

/** Only init/open call this; inspection and watcher reloads never access the network. */
export async function restoreMissingPackages(input: string, seen = new Set<string>(), missingOnly = true): Promise<Diagnostic[]> {
  const location = await resolveProjectLocation(input);
  if (seen.has(location.configPath)) return [];
  if (seen.size >= 64) return [diagnostic({code: "PACKAGE_RESTORE_FAILED", message: "Linked package restoration exceeded 64 bundles.", file: location.configPath})];
  seen.add(location.configPath);
  const diagnostics: Diagnostic[] = [];
  for (const restore of [() => syncComponents(location.configPath, { missingOnly }), () => syncThemes({ project: location.configPath }, { missingOnly })]) {
    try { await restore(); }
    catch (error) { diagnostics.push(diagnostic({ code: "PACKAGE_RESTORE_FAILED", message: `${errorMessage(error)} Retry Sync to restore the locked packages.`, file: location.lockPath })); }
  }
  const parsed = await parseDashboardConfig(location.configPath);
  async function visit(node: ComponentNode): Promise<void> {
    if (isConfigReference(node.component)) {
      try { diagnostics.push(...await restoreMissingPackages(await resolveConfigReferencePath(location, node.component), seen, missingOnly)); }
      // A broken config link remains the resolver's local diagnostic.
      catch { /* No target bundle exists to restore. */ }
    }
    for (const edge of childEdges(node.children)) await visit(edge.node);
  }
  if (parsed.value) await visit(parsed.value.root);
  return diagnostics;
}
