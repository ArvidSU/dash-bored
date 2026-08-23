import { createHash } from "node:crypto";
import { extname } from "node:path";
import { realpath } from "node:fs/promises";
import type { CompiledLocalComponent, Diagnostic } from "../shared/contracts";
import { diagnostic, errorMessage } from "./diagnostics";
import { isPathContained } from "./paths";
import type { LocalComponentDefinition } from "./tree";

const RUNTIME_GLOBAL = "__DASH_BORED_COMPONENT_RUNTIME__";
const ALLOWED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

const reactRuntimeSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
const React = runtime.React;
export default React;
export const createElement = runtime.createElement ?? React.createElement;
export const Fragment = runtime.Fragment ?? React.Fragment;
export const Children = React.Children;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
`;

const jsxRuntimeSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
export const Fragment = runtime.Fragment ?? runtime.React.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV ?? runtime.jsx;
`;

const componentSdkSource = `
const runtime = globalThis.${RUNTIME_GLOBAL};
if (!runtime) throw new Error("dash-bored component runtime is not installed");
const React = runtime.React;
export const defineComponent = runtime.defineComponent ?? ((component) => component);
export const createElement = runtime.createElement ?? React.createElement;
export const Fragment = runtime.Fragment ?? React.Fragment;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
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

/** Bundle trusted local code while replacing React and the component SDK with renderer globals. */
export async function compileLocalComponents(
  definitions: readonly LocalComponentDefinition[],
  options: CompileLocalComponentsOptions = {},
): Promise<CompileLocalComponentsResult> {
  const components: CompiledLocalComponent[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const definition of definitions) {
    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
      result = await Bun.build({
        entrypoints: [definition.entryPath],
        target: "browser",
        format: "esm",
        splitting: false,
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
      continue;
    }

    if (!result.success) {
      diagnostics.push(...result.logs.map((message) => buildDiagnostic(definition, message)));
      continue;
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
      continue;
    }

    const revision = createHash("sha256")
      .update(definition.manifest.id)
      .update("\0")
      .update(javascript)
      .update("\0")
      .update(css)
      .digest("hex")
      .slice(0, 20);
    components.push({
      componentId: definition.manifest.id,
      revision,
      javascript,
      css,
    });
  }

  return { components, diagnostics };
}
