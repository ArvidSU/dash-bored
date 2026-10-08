import { createHash } from "node:crypto";
import { extname } from "node:path";
import { realpath } from "node:fs/promises";
import type { CompiledLocalComponent, Diagnostic } from "../shared/contracts";
import { diagnostic, errorMessage } from "./diagnostics";
import { isPathContained } from "./paths";
import type { LocalComponentDefinition } from "./tree-catalog";
import { COMPONENT_REACT_EXPORTS, REACT_RUNTIME_EXPORTS } from "../shared/component-api";

const RUNTIME_GLOBAL = "__DASH_BORED_COMPONENT_RUNTIME__";
const ALLOWED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".css"]);

const reactRuntimeSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
const React = runtime.React;
export default React;
${REACT_RUNTIME_EXPORTS.map((name) => `export const ${name} = React.${name};`).join("\n")}
`;

const jsxRuntimeSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
export const Fragment = runtime.Fragment ?? runtime.React.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
`;

const jsxDevRuntimeSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
export const Fragment = runtime.Fragment ?? runtime.React.Fragment;
export const jsxDEV = runtime.jsxDEV;
`;

const componentSdkSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
const React = runtime.React;
export const useTheme = runtime.useTheme;
export const useComponentVisibility = runtime.useComponentVisibility;
export const trackActivity = runtime.trackActivity;
export const TerminalSurface = runtime.TerminalSurface;
export const defineComponent = runtime.defineComponent;
${COMPONENT_REACT_EXPORTS.map((name) => `export const ${name} = React.${name};`).join("\n")}
`;

function runtimePlugin(definition: LocalComponentDefinition): Bun.BunPlugin {
  return {
    name: `dash-bored-component-${definition.manifest.id}`,
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "dash-bored-runtime" }));
      build.onResolve({ filter: /^react\/jsx-(?:dev-)?runtime$/ }, (args) => ({
        path: args.path,
        namespace: "dash-bored-runtime",
      }));
      build.onResolve({ filter: /^@dash-bored\/component$/ }, () => ({
        path: "component-sdk",
        namespace: "dash-bored-runtime",
      }));
      build.onLoad({ filter: /.*/, namespace: "dash-bored-runtime" }, (args) => ({
        contents:
          args.path === "react"
            ? reactRuntimeSource
            : args.path === "component-sdk"
              ? componentSdkSource
              : args.path === "react/jsx-dev-runtime"
                ? jsxDevRuntimeSource
                : jsxRuntimeSource,
        loader: "js",
      }));

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path === definition.entryPath && args.importer === "") {
          return { path: definition.entryPath };
        }
        if (!args.path.startsWith(".")) {
          throw new Error(`Import ${JSON.stringify(args.path)} is not allowed in local components.`);
        }
        if (args.kind === "url-token") {
          throw new Error("CSS asset URLs are not supported in local components.");
        }

        let resolvedPath: string;
        try {
          resolvedPath = Bun.resolveSync(args.path, args.resolveDir);
        } catch (error) {
          throw new Error(`Cannot resolve ${JSON.stringify(args.path)}: ${errorMessage(error)}`);
        }
        resolvedPath = await realpath(resolvedPath);
        if (!isPathContained(definition.directory, resolvedPath)) {
          throw new Error(`Import ${JSON.stringify(args.path)} resolves outside the component directory.`);
        }
        if (!ALLOWED_SOURCE_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) {
          throw new Error(`Import ${JSON.stringify(args.path)} has an unsupported file type.`);
        }
        return { path: resolvedPath };
      });
    },
  };
}

function buildDiagnostic(definition: LocalComponentDefinition, message: unknown): Diagnostic {
  const buildMessage = message as {
    message?: string;
    position?: { file?: string; line?: number; column?: number } | null;
  };
  const position = buildMessage.position;
  return diagnostic({
    code: "COMPONENT_COMPILE_FAILED",
    message: buildMessage.message ?? errorMessage(message),
    file: position?.file || definition.entryPath,
    ...(position?.line === undefined ? {} : { line: position.line + 1 }),
    ...(position?.column === undefined ? {} : { column: position.column + 1 }),
  });
}

export interface CompileLocalComponentsOptions {
  minify?: boolean;
}

export interface CompileLocalComponentsResult {
  components: CompiledLocalComponent[];
  diagnostics: Diagnostic[];
}

async function compileDefinition(
  definition: LocalComponentDefinition,
  options: CompileLocalComponentsOptions,
): Promise<CompileLocalComponentsResult> {
  const components: CompiledLocalComponent[] = [];
  const diagnostics: Diagnostic[] = [];
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [definition.entryPath],
      target: "browser",
      format: "esm",
      splitting: false,
      jsx: { runtime: "automatic", importSource: "react", development: false },
      minify: options.minify ?? false,
      sourcemap: "none",
      plugins: [runtimePlugin(definition)],
    });
  } catch (error) {
    if (error instanceof AggregateError && error.errors.length > 0) {
      diagnostics.push(...error.errors.map((item) => buildDiagnostic(definition, item)));
    } else {
      diagnostics.push(buildDiagnostic(definition, error));
    }
    return { components, diagnostics };
  }

  if (!result.success) {
    diagnostics.push(...result.logs.map((message) => buildDiagnostic(definition, message)));
    return { components, diagnostics };
  }

  let javascript = "";
  let css = "";
  for (const output of result.outputs) {
    const value = await output.text();
    if (output.path.endsWith(".css")) css += value;
    else if (output.path.endsWith(".js")) javascript += value;
  }
  if (javascript === "") {
    diagnostics.push(
      diagnostic({
        code: "COMPONENT_COMPILE_EMPTY",
        message: "The component bundle did not produce JavaScript.",
        file: definition.entryPath,
      }),
    );
    return { components, diagnostics };
  }

  const revision = createHash("sha256")
    .update(definition.manifest.id)
    .update("\0")
    .update(javascript)
    .update("\0")
    .update(css)
    .digest("hex")
    .slice(0, 20);
  components.push({ componentId: definition.manifest.id, revision, javascript, css });
  return { components, diagnostics };
}

/** Bundle trusted local code while replacing React and the component SDK with renderer globals. */
export async function compileLocalComponents(
  definitions: readonly LocalComponentDefinition[],
  options: CompileLocalComponentsOptions = {},
): Promise<CompileLocalComponentsResult> {
  const components: CompiledLocalComponent[] = [];
  const diagnostics: Diagnostic[] = [];
  const ordered = [...definitions].sort((a,b) => a.manifest.id.localeCompare(b.manifest.id));
  for (let offset = 0; offset < ordered.length; offset += 2) {
    const batch = ordered.slice(offset, offset + 2);
    const results = await Promise.allSettled(batch.map((definition) => compileDefinition(definition, options)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      components.push(...result.value.components);
      diagnostics.push(...result.value.diagnostics);
    }
  }

  return { components, diagnostics };
}
