import { parsePackageScripts } from "./lib/package-scripts";

export interface PulseStatus {
  state: "healthy";
  detail: string;
}

export interface PulseChart {
  labels: string[];
  series: Array<{ label: string; values: number[] }>;
}

const CATEGORY_RULES: Array<[string, RegExp]> = [
  ["test", /(^|:)(test|spec|check)(:|$)/i],
  ["build", /(^|:)(build|compile|bundle)(:|$)/i],
  ["quality", /(^|:)(lint|typecheck|format|qa)(:|$)/i],
  ["development", /(^|:)(dev|start|serve|watch)(:|$)/i],
];

function scriptCategory(name: string): string {
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

export function projectPulseStatus(source: string): PulseStatus {
  const manifest = parsePackageScripts(source);
  const name = manifest.name ?? "Unnamed project";
  const version = manifest.version ? ` v${manifest.version}` : "";
  const count = manifest.scripts.length;
  return {
    state: "healthy",
    detail: `${name}${version} · ${count} package ${count === 1 ? "script" : "scripts"}`,
  };
}

export function projectPulseChart(source: string): PulseChart {
  const manifest = parsePackageScripts(source);
  const counts = new Map<string, number>();
  for (const { name } of manifest.scripts) {
    const category = scriptCategory(name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const categories = [...counts.keys()].sort((left, right) => left.localeCompare(right));
  return {
    labels: categories,
    series: [{ label: "Package scripts", values: categories.map((category) => counts.get(category) ?? 0) }],
  };
}

if (import.meta.main) {
  const kind = process.argv[2];
  if (kind !== "status" && kind !== "chart") {
    process.stderr.write("Usage: bun run .dash-bored/scripts/project-pulse.ts <status|chart>\n");
    process.exit(2);
  }
  const manifestPath = process.env.DASH_BORED_PACKAGE_FILE || "package.json";
  try {
    const source = await Bun.file(manifestPath).text();
    const result = kind === "status" ? projectPulseStatus(source) : projectPulseChart(source);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
}
