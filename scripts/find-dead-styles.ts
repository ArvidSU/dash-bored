import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

type HookKind = "class" | "id";
type HookStatus = "used" | "dynamic" | "dead";

export interface SourceFile {
  path: string;
  content: string;
}

export interface StyleHook {
  kind: HookKind;
  name: string;
  lines: number[];
  selectors: string[];
}

export interface StyleAnalysis {
  used: StyleHook[];
  dynamic: StyleHook[];
  dead: StyleHook[];
}

interface CssSelector {
  selector: string;
  line: number;
}

interface ParsedHook {
  kind: HookKind;
  name: string;
  selector: CssSelector;
}

interface MutableStyleHook {
  kind: HookKind;
  name: string;
  lines: Set<number>;
  selectors: Set<string>;
}

const SOURCE_EXTENSIONS = new Set([".html", ".js", ".jsx", ".ts", ".tsx"]);

function maskComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineAt(value: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (value[index] === "\n") line += 1;
  }
  return line;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

function splitSelectorList(value: string): Array<{ selector: string; offset: number }> {
  const selectors: Array<{ selector: string; offset: number }> = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: string | null = null;
  let escaped = false;

  const addSelector = (end: number) => {
    const raw = value.slice(start, end);
    const leadingWhitespace = raw.search(/\S/);
    if (leadingWhitespace === -1) return;
    selectors.push({
      selector: normalizeSelector(raw),
      offset: start + leadingWhitespace,
    });
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets = Math.max(0, brackets - 1);
    } else if (character === "," && parentheses === 0 && brackets === 0) {
      addSelector(index);
      start = index + 1;
    }
  }
  addSelector(value.length);
  return selectors;
}

function parseCssSelectors(css: string): CssSelector[] {
  const masked = maskComments(css);
  const selectors: CssSelector[] = [];
  const blockKinds: Array<"style" | "at-rule" | "keyframes"> = [];
  let preludeStart = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ";") {
      preludeStart = index + 1;
      continue;
    }
    if (character === "{") {
      const prelude = masked.slice(preludeStart, index);
      const trimmedPrelude = prelude.trim();
      const insideKeyframes = blockKinds.includes("keyframes");
      if (trimmedPrelude && !trimmedPrelude.startsWith("@") && !insideKeyframes) {
        for (const item of splitSelectorList(prelude)) {
          selectors.push({
            selector: item.selector,
            line: lineAt(css, preludeStart + item.offset),
          });
        }
      }

      const atRule = trimmedPrelude.match(/^@([\w-]+)/)?.[1];
      blockKinds.push(
        atRule?.toLowerCase().endsWith("keyframes")
          ? "keyframes"
          : trimmedPrelude.startsWith("@")
            ? "at-rule"
            : "style",
      );
      preludeStart = index + 1;
      continue;
    }
    if (character === "}") {
      blockKinds.pop();
      preludeStart = index + 1;
    }
  }
  return selectors;
}

function extractHooks(selector: CssSelector): ParsedHook[] {
  const hooks: ParsedHook[] = [];
  let brackets = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < selector.selector.length; index += 1) {
    const character = selector.selector[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      brackets += 1;
      continue;
    }
    if (character === "]") {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (brackets > 0 || (character !== "." && character !== "#")) continue;

    const name = selector.selector
      .slice(index + 1)
      .match(/^(?:--|[-_a-zA-Z])[-_a-zA-Z0-9]*/)?.[0];
    if (!name || name === "-") continue;
    hooks.push({
      kind: character === "." ? "class" : "id",
      name,
      selector,
    });
    index += name.length;
  }
  return hooks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactReference(name: string, source: string): boolean {
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`,
  ).test(source);
}

function hasDynamicReference(name: string, source: string): boolean {
  for (const separator of ["--", "__"]) {
    let separatorIndex = name.indexOf(separator);
    while (separatorIndex !== -1) {
      const prefix = name.slice(0, separatorIndex + separator.length);
      if (prefix.length >= 4) {
        let sourceIndex = source.indexOf(prefix);
        while (sourceIndex !== -1) {
          const suffix = source.slice(sourceIndex + prefix.length);
          if (/^\$\{|^["'`]\s*\+/.test(suffix)) return true;
          sourceIndex = source.indexOf(prefix, sourceIndex + prefix.length);
        }
      }
      separatorIndex = name.indexOf(separator, separatorIndex + separator.length);
    }
  }
  return false;
}

function addHook(map: Map<string, MutableStyleHook>, hook: ParsedHook): void {
  const key = `${hook.kind}:${hook.name}`;
  const existing = map.get(key) ?? {
    kind: hook.kind,
    name: hook.name,
    lines: new Set<number>(),
    selectors: new Set<string>(),
  };
  existing.lines.add(hook.selector.line);
  existing.selectors.add(hook.selector.selector);
  map.set(key, existing);
}

function freezeHook(hook: MutableStyleHook): StyleHook {
  return {
    kind: hook.kind,
    name: hook.name,
    lines: [...hook.lines].sort((left, right) => left - right),
    selectors: [...hook.selectors].sort(),
  };
}

function classifyHooks(hooks: MutableStyleHook[], source: string): Record<HookStatus, StyleHook[]> {
  const result: Record<HookStatus, StyleHook[]> = { used: [], dynamic: [], dead: [] };
  for (const hook of hooks) {
    const status = hasExactReference(hook.name, source)
      ? "used"
      : hasDynamicReference(hook.name, source)
        ? "dynamic"
        : "dead";
    result[status].push(freezeHook(hook));
  }
  for (const status of ["used", "dynamic", "dead"] as const) {
    result[status].sort(
      (left, right) =>
        (left.lines[0] ?? Number.MAX_SAFE_INTEGER) - (right.lines[0] ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    );
  }
  return result;
}

export function analyzeStyles(
  css: string,
  sourceFiles: readonly Pick<SourceFile, "content">[],
): StyleAnalysis {
  const hooks = new Map<string, MutableStyleHook>();
  for (const selector of parseCssSelectors(css)) {
    for (const hook of extractHooks(selector)) addHook(hooks, hook);
  }
  const source = sourceFiles.map((file) => maskComments(file.content)).join("\n");
  return classifyHooks([...hooks.values()], source);
}

export async function collectRuntimeSourceFiles(directory: string): Promise<SourceFile[]> {
  const paths: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        paths.push(path);
      }
    }
  }

  await visit(directory);
  paths.sort();
  return Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, "utf8") })));
}

function hookLabel(hook: StyleHook): string {
  return `${hook.kind === "class" ? "." : "#"}${hook.name}`;
}

function printHooks(title: string, hooks: readonly StyleHook[]): void {
  if (hooks.length === 0) return;
  console.log(`${title} (${hooks.length}):`);
  for (const hook of hooks) {
    console.log(
      `  ${hookLabel(hook)} (line${hook.lines.length === 1 ? "" : "s"} ${hook.lines.join(", ")})`,
    );
    for (const selector of hook.selectors) console.log(`    ${selector}`);
  }
}

function printTextReport(cssPath: string, sourceRoot: string, analysis: StyleAnalysis): void {
  console.log(
    `Analyzed ${relative(process.cwd(), cssPath)} against source in ${relative(process.cwd(), sourceRoot)}.`,
  );
  printHooks("Dead style hooks", analysis.dead);
  printHooks("Dynamic style hooks requiring manual review", analysis.dynamic);
  if (analysis.dead.length === 0) console.log("No definitely dead style hooks found.");
  if (analysis.dynamic.length > 0) {
    console.log("Dynamic hooks are considered live because their state/value is assembled at runtime.");
  }
}

interface CliOptions {
  check: boolean;
  json: boolean;
  cssPath: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  let check = false;
  let json = false;
  let cssPath = "src/renderer/styles.css";
  let cssPathProvided = false;
  for (const argument of args) {
    if (argument === "--check") {
      check = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun run styles:dead [--check] [--json] [path/to/styles.css]");
      process.exit(0);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (cssPathProvided) {
      throw new Error("Only one stylesheet path may be provided.");
    } else {
      cssPath = argument;
      cssPathProvided = true;
    }
  }
  return { check, json, cssPath };
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const options = parseArguments(process.argv.slice(2));
  const cssPath = resolve(root, options.cssPath);
  const sourceRoot = resolve(root, "src/renderer");
  const [css, sourceFiles] = await Promise.all([
    readFile(cssPath, "utf8"),
    collectRuntimeSourceFiles(sourceRoot),
  ]);
  const analysis = analyzeStyles(css, sourceFiles);

  if (options.json) {
    console.log(
      JSON.stringify(
        { cssPath: relative(root, cssPath), sourceRoot: relative(root, sourceRoot), ...analysis },
        null,
        2,
      ),
    );
  } else {
    printTextReport(cssPath, sourceRoot, analysis);
  }
  if (options.check && analysis.dead.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
