import { packageRunner, parsePackageScripts } from "../components/package-scripts/package-scripts";

export interface PackageScriptListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  name: string;
  runner: string;
}

export function packageScriptListItems(source: string): PackageScriptListItem[] {
  const manifest = parsePackageScripts(source);
  const runner = packageRunner(manifest.packageManager);
  return manifest.scripts.map(({ name, command }) => ({
    id: `script:${name}`,
    title: name,
    detail: command,
    tags: ["script", runner],
    name,
    runner,
  }));
}

export function packageScriptsListJson(source: string): string {
  return JSON.stringify(packageScriptListItems(source));
}

if (import.meta.main) {
  const manifestPath = process.env.DASH_BORED_PACKAGE_FILE || "package.json";
  try {
    const source = await Bun.file(manifestPath).text();
    process.stdout.write(`${packageScriptsListJson(source)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
}
