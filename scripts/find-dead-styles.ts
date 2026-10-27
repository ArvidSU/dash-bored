import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import postcss, { type AtRule, type Node } from "postcss";
import selectorParser from "postcss-selector-parser";

type HookKind = "class" | "id";
type HookStatus = "used" | "dynamic" | "dead";

export interface SourceFile { path: string; content: string }
export interface StyleHook {
  kind: HookKind;
  name: string;
  lines: number[];
  selectors: string[];
}
export interface StyleAnalysis { used: StyleHook[]; dynamic: StyleHook[]; dead: StyleHook[] }

interface CollectedHook {
  kind: HookKind;
  name: string;
  lines: Set<number>;
  selectors: Set<string>;
}

const SOURCE_EXTENSIONS = new Set([".html", ".js", ".jsx", ".ts", ".tsx"]);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasDynamicReference(name: string, source: string): boolean {
  for (const separator of ["--", "__"]) {
    let index = name.indexOf(separator);
    while (index !== -1) {
      const prefix = name.slice(0, index + separator.length);
      const dynamic = `${escapeRegExp(prefix)}(?:\\$\\{|["'\x60]\\s*\\+)`;
      if (prefix.length >= 4 && new RegExp(dynamic).test(source)) return true;
      index = name.indexOf(separator, index + separator.length);
    }
  }
  return false;
}

export function analyzeStyles(css: string, sourceFiles: readonly Pick<SourceFile, "content">[]): StyleAnalysis {
  const hooks = new Map<string, CollectedHook>();
  postcss.parse(css).walkRules((rule) => {
    // Keyframe selectors name animation stops, not DOM elements.
    for (let parent: Node["parent"] = rule.parent; parent; parent = parent.parent) {
      if (parent.type === "atrule" && (parent as AtRule).name.toLowerCase().endsWith("keyframes")) return;
    }
    const selectorText = rule.selector.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    for (const item of selectorParser().astSync(selectorText).nodes) {
      const raw = item.toString();
      const leading = raw.search(/\S/);
      if (leading < 0) continue;
      const offset = (item.sourceIndex ?? 0) + leading;
      const line = (rule.source?.start?.line ?? 1) + (selectorText.slice(0, offset).match(/\n/g)?.length ?? 0);
      const selector = raw.replace(/\s+/g, " ").trim();
      item.walk((node) => {
        if (node.type !== "class" && node.type !== "id") return;
        const key = `${node.type}:${node.value}`;
        const hook = hooks.get(key) ?? {
          kind: node.type, name: node.value, lines: new Set<number>(), selectors: new Set<string>(),
        };
        hook.lines.add(line);
        hook.selectors.add(selector);
        hooks.set(key, hook);
      });
    }
  });

  const source = sourceFiles.map(({ content }) => content.replace(/\/\*[\s\S]*?\*\//g, " ")).join("\n");
  const result: Record<HookStatus, StyleHook[]> = { used: [], dynamic: [], dead: [] };
  for (const hook of hooks.values()) {
    const exact = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(hook.name)}(?![A-Za-z0-9_-])`).test(source);
    const status = exact ? "used" : hasDynamicReference(hook.name, source) ? "dynamic" : "dead";
    result[status].push({
      ...hook,
      lines: [...hook.lines].sort((a, b) => a - b),
      selectors: [...hook.selectors].sort(),
    });
  }
  for (const entries of Object.values(result)) {
    entries.sort((a, b) => (a.lines[0] ?? Number.MAX_SAFE_INTEGER) - (b.lines[0] ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
  }
  return result;
}

export async function collectRuntimeSourceFiles(directory: string): Promise<SourceFile[]> {
  const paths: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const path of glob.scan({
    cwd: directory, absolute: true, onlyFiles: true, dot: true, followSymlinks: false,
  })) {
    if (relative(directory, path).split(sep).slice(0, -1).some((segment) => segment.startsWith("."))) continue;
    if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) paths.push(path);
  }
  return Promise.all(paths.sort().map(async (path) => ({ path, content: await readFile(path, "utf8") })));
}

function printHooks(title: string, hooks: readonly StyleHook[]): void {
  if (!hooks.length) return;
  console.log(`${title} (${hooks.length}):`);
  for (const hook of hooks) {
    const label = `${hook.kind === "class" ? "." : "#"}${hook.name}`;
    console.log(`  ${label} (line${hook.lines.length === 1 ? "" : "s"} ${hook.lines.join(", ")})`);
    for (const selector of hook.selectors) console.log(`    ${selector}`);
  }
}

async function main(): Promise<void> {
  let check = false;
  let json = false;
  let cssPath: string | undefined;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--check") check = true;
    else if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun run styles:dead [--check] [--json] [path/to/styles.css]");
      return;
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (cssPath !== undefined) throw new Error("Only one stylesheet path may be provided.");
    else cssPath = argument;
  }
  const root = resolve(import.meta.dirname, "..");
  const stylesheet = resolve(root, cssPath ?? "src/renderer/styles.css");
  const sourceRoot = resolve(root, "src/renderer");
  const [css, sources] = await Promise.all([readFile(stylesheet, "utf8"), collectRuntimeSourceFiles(sourceRoot)]);
  const analysis = analyzeStyles(css, sources);
  if (json) console.log(JSON.stringify({ cssPath: relative(root, stylesheet), sourceRoot: relative(root, sourceRoot), ...analysis }, null, 2));
  else {
    console.log(`Analyzed ${relative(process.cwd(), stylesheet)} against source in ${relative(process.cwd(), sourceRoot)}.`);
    printHooks("Dead style hooks", analysis.dead);
    printHooks("Dynamic style hooks requiring manual review", analysis.dynamic);
    if (!analysis.dead.length) console.log("No definitely dead style hooks found.");
    if (analysis.dynamic.length) console.log("Dynamic hooks are considered live because their state/value is assembled at runtime.");
  }
  if (check && analysis.dead.length) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
