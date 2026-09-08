import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { DashboardMigration, ReleaseMetadata } from "../shared/updates";

export async function inspectMigration(configPath: string, release: Pick<ReleaseMetadata, "minimumContract" | "dashboardContract" | "recipes">): Promise<DashboardMigration> {
  let contract: number | null = null;
  try {
    const text = await readFile(configPath, "utf8");
    if (text.length > 1_000_000) throw new Error("Dashboard is too large to inspect.");
    const doc = parse(text, { maxAliasCount: 100 });
    if (Number.isSafeInteger(doc?.schemaVersion)) contract = doc.schemaVersion;
  } catch (error) {
    return { configPath, contract, status: "unsupported", steps: [], message: `Cannot determine dashboard contract: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (contract === null || contract < release.minimumContract || contract > release.dashboardContract) return { configPath, contract, status: "unsupported", steps: [], message: `Contract ${contract ?? "unknown"} has no supported migration path. Historical v1-to-v2 conversion is not provided.` };
  const steps = release.recipes.filter(r => r.from >= contract! && r.to <= release.dashboardContract).sort((a, b) => a.from - b.from);
  return { configPath, contract, status: steps.length ? "required" : "current", steps, message: steps.length ? steps.map(r => r.title).join("; ") : "No dashboard migration required." };
}
