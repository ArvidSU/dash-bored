import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SDK_FILES } from "../component-api/assets.generated";
import { APP_VERSION } from "../shared/app-metadata";
import { COMPONENT_API_VERSION, COMPONENT_CAPABILITIES, COMPONENT_RUNTIME_EXPORTS, REACT_RUNTIME_EXPORTS, SUPPORTED_COMPONENT_API_VERSIONS } from "../shared/component-api";
import type { Diagnostic } from "../shared/contracts";
import { CoreError, diagnostic, hasErrors } from "./diagnostics";
import { writeFileAtomically } from "./fs-atomic";
import { resolveContainedPath } from "./paths";
import { loadLocalDefinition, type LocalComponentDefinition } from "./tree-catalog";
import { compileLocalComponents } from "./compiler";
import { parseComponentManifest } from "./yaml";

export const SDK_DIGEST = createHash("sha256").update(JSON.stringify(Object.entries(SDK_FILES).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
export interface ComponentCheckStage { name: string; ok: boolean; status: "passed" | "failed" | "not-run"; }
export interface ComponentCheckResult {
  ok: boolean;
  apiVersion: string | null;
  appVersion: string;
  sdkDigest: string;
  stages: ComponentCheckStage[];
  diagnostics: Diagnostic[];
}

export function componentApiInfo(version = COMPONENT_API_VERSION) {
  if (!SUPPORTED_COMPONENT_API_VERSIONS.includes(version)) throw new CoreError("COMPONENT_API_UNSUPPORTED", `API ${version} is unsupported; supported targets: ${SUPPORTED_COMPONENT_API_VERSIONS.join(", ")}.`);
  return {
    apiVersion: version, appVersion: APP_VERSION, supportedTargets: SUPPORTED_COMPONENT_API_VERSIONS,
    manifestSchemaVersion: 3, dashboardContract: 4, typescriptVersion: ts.version,
    reactVersion: "18.3.1", sdkDigest: SDK_DIGEST,
    authoring: {
      skill: "dash-bored", reference: "references/components.md#standalone-component-authoring",
      workflow: ["component api --json", "component init <directory>", "component setup <directory>", "component check <directory> --json"],
      editor: "Setup installs ambient public modules and private declaration aliases without redirecting runtime imports. Use installed SDK types rather than copying app interfaces.",
      preview: "Use an existing dashboard and the ordinary app control channel; standalone authoring does not require initializing a dashboard.",
    },
    modules: { "@dash-bored/component": COMPONENT_RUNTIME_EXPORTS, react: REACT_RUNTIME_EXPORTS, "react/jsx-runtime": ["Fragment", "jsx", "jsxs"], "react/jsx-dev-runtime": ["Fragment", "jsxDEV"] },
    capabilities: COMPONENT_CAPABILITIES,
    alwaysAvailable: ["dashboard.reload", "dashboard.updateProps", "actions.register", "actions.resolve", "actions.invoke"],
    permissionActivation: "Static permissions plus permissionsByProp paths whose values are not undefined, null, or false.",
    failure: "Missing capabilities are optional host members. Privileged promise-returning calls recheck trust and permissions and reject on denial, validation, transport or bounded-operation failure; catch the error message. HTTP error statuses and shell nonzero exits are returned as results. actions.invoke returns void; inspect actions.resolve(...).invocation for running, completed or failed outcomes.",
    lifecycle: "Clean up effects and action registrations on unmount. useComponentVisibility reports hidden mounted panels; trackActivity counts bounded asynchronous work for agent idle detection. Reload may replace a component; updateProps replaces its whole props object in the owning draft.",
    defaults: "JSON Schema defaults describe recommendations; component code implements runtime fallbacks.",
    compatibility: "Exact stable API targets; minor additions, major breaking changes. Supported targets retain matched declarations. Deprecations include replacements and migration notes before removal in a major API version.",
    securityBoundary: "Project trust. Trusted component code shares the renderer; permissions are not a component sandbox.",
    imports: "Contained relative .ts/.tsx/.js/.css files and the listed virtual modules. Other bare packages must be bundled at publication; Node/Electrobun APIs and escaping imports are unsupported.",
  };
}

export function sdkCompilerPaths(sdkDirectory: string): Record<string, string[]> {
  return {
    "@dash-bored/component": [join(sdkDirectory, "index.d.ts")],
    react: [join(sdkDirectory, "react.d.ts")],
    "@dash-bored/react-types": [join(sdkDirectory, "vendor/@types/react/index.d.ts")],
    "react/jsx-runtime": [join(sdkDirectory, "vendor/@types/react/jsx-runtime.d.ts")],
    "react/jsx-dev-runtime": [join(sdkDirectory, "vendor/@types/react/jsx-dev-runtime.d.ts")],
    csstype: [join(sdkDirectory, "vendor/csstype/index.d.ts")],
    "prop-types": [join(sdkDirectory, "vendor/@types/prop-types/index.d.ts")],
  };
}

/** Editor-only aliases referenced by ambient declarations, never by runtime code. */
export function sdkEditorPaths(sdkDirectory: string): Record<string, string[]> {
  const paths = sdkCompilerPaths(sdkDirectory);
  return {
    "@dash-bored/component-types": paths["@dash-bored/component"]!,
    "@dash-bored/react-facade": paths.react!,
    "@dash-bored/react-types": paths["@dash-bored/react-types"]!,
    "@dash-bored/react-jsx-types": paths["react/jsx-runtime"]!,
    "@dash-bored/react-jsx-dev-types": paths["react/jsx-dev-runtime"]!,
    "@dash-bored/css-types": paths.csstype!,
    "@dash-bored/prop-types": paths["prop-types"]!,
  };
}

const browserOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], jsx: ts.JsxEmit.ReactJSX,
  strict: true, noEmit: true, esModuleInterop: true, allowImportingTsExtensions: true,
  types: [], skipLibCheck: false,
};

/** A compiler host that reads the shipped SDK/library assets in memory, without installation. */
export function createComponentTypeScriptHost(sdkDirectory: string, options: ts.CompilerOptions): ts.CompilerHost {
  const native = ts.createCompilerHost(options);
  const files = new Map(Object.entries(SDK_FILES).map(([name, text]) => [resolve(sdkDirectory, name), text]));
  const directories = new Set<string>();
  for (const file of files.keys()) { let directory = dirname(file); while (directory.startsWith(sdkDirectory)) { directories.add(directory); if (directory === sdkDirectory) break; directory = dirname(directory); } }
  const read = (path: string) => files.get(resolve(path)) ?? native.readFile(path);
  return {
    ...native,
    fileExists: (path) => files.has(resolve(path)) || native.fileExists(path),
    directoryExists: (path) => directories.has(resolve(path)) || (native.directoryExists?.(path) ?? false),
    realpath: (path) => files.has(resolve(path)) || directories.has(resolve(path)) ? resolve(path) : native.realpath?.(path) ?? path,
    readFile: read,
    getSourceFile: (path, languageVersion) => { const text = read(path); return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true); },
    getDefaultLibFileName: () => join(sdkDirectory, "typescript/lib/lib.es2022.full.d.ts"),
    getDefaultLibLocation: () => join(sdkDirectory, "typescript/lib"),
  };
}

function tsDiagnostics(items: readonly ts.Diagnostic[]): Diagnostic[] {
  return items.map((item) => {
    const position = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : undefined;
    return diagnostic({ code: `COMPONENT_TYPESCRIPT_${item.code}`, severity: item.category === ts.DiagnosticCategory.Warning ? "warning" : "error",
      message: ts.flattenDiagnosticMessageText(item.messageText, "\n"), ...(item.file ? { file: item.file.fileName } : {}),
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) });
  });
}

export function checkComponentTypes(definition: LocalComponentDefinition): Diagnostic[] {
  const sdkDirectory = resolve(definition.directory, ".dash-bored-sdk");
  const options = { ...browserOptions, paths: sdkCompilerPaths(sdkDirectory) };
  const declarationEntry = definition.manifest.types && resolve(definition.directory, definition.manifest.types);
  const entry = definition.entryPath.endsWith(".js") ? declarationEntry : definition.entryPath;
  if (!entry) return [diagnostic({ code: "COMPONENT_TYPES_REQUIRED", message: "Generated JavaScript requires a contained types declaration entry.", file: definition.manifestPath, path: "/types" })];
  const host = createComponentTypeScriptHost(sdkDirectory, options);
  const harnessPath = resolve(definition.directory, ".dash-bored-entry-check.ts");
  const harness = `import type Component from ${JSON.stringify(entry)};\nimport type { ComponentType } from "react";\nimport type { LocalComponentRenderProps } from "@dash-bored/component";\ndeclare const exported: typeof Component;\nconst component: ComponentType<LocalComponentRenderProps<any>> = exported;\nexport default component;\n`;
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, onError, fresh) => file === harnessPath ? ts.createSourceFile(file, harness, version, true) : getSourceFile(file, version, onError, fresh);
  const result = ts.createProgram([entry, harnessPath, join(sdkDirectory, "css.d.ts")], options, host);
  return tsDiagnostics(ts.getPreEmitDiagnostics(result));
}

function checkSourceProject(configPath: string): Diagnostic[] {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return tsDiagnostics([config.error]);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const sdkDirectory = resolve(dirname(configPath), ".dash-bored-sdk");
  const options = { ...parsed.options, strict: true, noEmit: true, paths: { ...parsed.options.paths, ...sdkCompilerPaths(sdkDirectory) } };
  const program = ts.createProgram([...parsed.fileNames, join(sdkDirectory, "css.d.ts")], options, createComponentTypeScriptHost(sdkDirectory, options));
  return [...tsDiagnostics(parsed.errors), ...tsDiagnostics(ts.getPreEmitDiagnostics(program))];
}

export async function checkComponentDirectory(directory: string, options: { sourceProject?: string } = {}): Promise<ComponentCheckResult> {
  const stages: ComponentCheckStage[] = [];
  const diagnostics: Diagnostic[] = [];
  const stage = (name: string, items: Diagnostic[], ran = true) => { diagnostics.push(...items); stages.push({ name, ok: ran && !hasErrors(items), status: !ran ? "not-run" : hasErrors(items) ? "failed" : "passed" }); };
  const absolute = resolve(directory);
  const parent = dirname(absolute);
  const loaded = await loadLocalDefinition({ projectRoot: parent, configDirectory: parent, configPath: join(parent, "dash-bored.yaml"), lockPath: join(parent, "dash-bored-lock.yaml"), componentsDirectory: parent }, `./components/${basename(absolute)}`);
  stage("manifest", loaded.diagnostics);
  if (loaded.definition) {
    stage(loaded.definition.entryPath.endsWith(".js") ? "declaration-interface" : "typescript-source", checkComponentTypes(loaded.definition));
    if (options.sourceProject) stage("publication-source", checkSourceProject(resolve(options.sourceProject)));
    else stage("publication-source", [], false);
    const compiled = await compileLocalComponents([loaded.definition]);
    stage("production-bundle", compiled.diagnostics);
  }
  stage("dashboard-references", [], false);
  stage("visual-preview", [], false);
  return { ok: !hasErrors(diagnostics), apiVersion: loaded.definition?.manifest.apiVersion ?? null, appVersion: APP_VERSION, sdkDigest: SDK_DIGEST, stages, diagnostics };
}

async function authoringTarget(directory: string): Promise<string> {
  const targets = new Set<string>();
  let count = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 16 || ++count > 1000) throw new CoreError("COMPONENT_SETUP_LIMIT", "Component discovery exceeded setup limits.");
    if (await Bun.file(join(path, "component.yaml")).exists()) {
      const parsed = await parseComponentManifest(join(path, "component.yaml"));
      if (!parsed.value) throw new CoreError("COMPONENT_SETUP_MANIFEST", parsed.diagnostics.map((item) => item.message).join("\n"));
      targets.add(parsed.value.apiVersion); return;
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !["node_modules", ".git", ".dash-bored-sdk", ".dash-bored"].includes(entry.name)) await visit(join(path, entry.name), depth + 1);
    }
  };
  await visit(directory, 0);
  if (targets.size !== 1) throw new CoreError("COMPONENT_SETUP_TARGET", "Setup requires components with one explicit, supported API target.");
  return [...targets][0]!;
}

export async function setupComponentAuthoring(directory: string, options: { tsconfig?: string } = {}) {
  const componentDirectory = await realpath(resolve(directory));
  const apiVersion = await authoringTarget(componentDirectory);
  componentApiInfo(apiVersion);
  const configPath = options.tsconfig ? resolve(options.tsconfig) : join(componentDirectory, "tsconfig.json");
  const configDirectory = dirname(configPath);
  const sdkDirectory = join(configDirectory, ".dash-bored-sdk");
  // Preflight every write, including parent symlinks, before replacing any owned asset.
  await resolveContainedPath(configDirectory, ".dash-bored-sdk", { mustExist: false });
  const receiptPath = join(sdkDirectory, "sdk-version.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "null"; throw error; })) as { files: Record<string, string> } | null;
  for (const [name, contents] of Object.entries(SDK_FILES)) {
    const path = await resolveContainedPath(configDirectory, relative(configDirectory, join(sdkDirectory, name)), { mustExist: false });
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing !== null && existing !== contents && receipt?.files[name] !== createHash("sha256").update(existing).digest("hex")) throw new CoreError("COMPONENT_SDK_MODIFIED", `SDK file ${path} has local edits; preserve or reconcile them before setup.`);
  }
  if ((await lstat(configPath).catch(() => null))?.isSymbolicLink()) throw new CoreError("COMPONENT_SETUP_CONFIG", "Setup will not replace a symlinked TypeScript configuration.");
  const existingConfig = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const parsed = existingConfig === null ? { config: { compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, noEmit: true, esModuleInterop: true, types: [] }, include: ["**/*.ts", "**/*.tsx"], exclude: ["node_modules"] } } : ts.parseConfigFileTextToJson(configPath, existingConfig);
  if (parsed.error) throw new CoreError("COMPONENT_SETUP_CONFIG", ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  const config = parsed.config as { compilerOptions?: ts.CompilerOptions & { paths?: Record<string, string[]> }; files?: string[] };
  const effective = ts.parseJsonConfigFileContent(structuredClone(config), ts.sys, configDirectory, undefined, configPath);
  const configErrors = effective.errors.filter((error) => error.code !== 18003);
  if (configErrors.length) throw new CoreError("COMPONENT_SETUP_CONFIG", configErrors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  // Paths inherit their declaring config's directory when no baseUrl is set.
  // Adding paths to this config must preserve that resolution and any baseUrl.
  const mappingBase = effective.options.baseUrl ?? configDirectory;
  const previousBase = effective.options.baseUrl ?? (effective.options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ?? configDirectory;
  const relativeMapping = (path: string) => `./${relative(mappingBase, path).replaceAll("\\", "/")}`;
  const mappings = Object.fromEntries(Object.entries(sdkEditorPaths(sdkDirectory)).map(([name, paths]) => [name, paths.map(relativeMapping)]));
  const previous = Object.fromEntries(Object.entries(effective.options.paths ?? {}).map(([name, paths]) => [name, paths.map((path) => relativeMapping(resolve(previousBase, path)))]));
  // Remove the earlier SDK's runtime aliases only when a receipt identifies
  // this installation and their targets still match our managed files.
  if (receipt?.files["index.d.ts"]) {
    for (const [name, paths] of Object.entries(sdkCompilerPaths(sdkDirectory))) {
      if (name in mappings) continue;
      if (JSON.stringify(previous[name]) === JSON.stringify(paths.map(relativeMapping))) delete previous[name];
    }
  }
  for (const [name, paths] of Object.entries(mappings)) {
    if (previous[name] && JSON.stringify(previous[name]) !== JSON.stringify(paths)) throw new CoreError("COMPONENT_SETUP_CONFIG_CONFLICT", `TypeScript mapping ${name} already exists; reconcile it with the shipped SDK before setup.`);
  }
  config.compilerOptions = { ...config.compilerOptions, paths: { ...previous, ...mappings } };
  config.files = [...new Set([...(config.files ?? effective.raw.files ?? []), "./.dash-bored-sdk/modules.d.ts", "./.dash-bored-sdk/css.d.ts"])];
  const files = Object.fromEntries(Object.entries(SDK_FILES).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")]));
  await mkdir(sdkDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(SDK_FILES)) { const path = join(sdkDirectory, name); await mkdir(dirname(path), { recursive: true }); await writeFileAtomically(path, contents); }
  await writeFileAtomically(receiptPath, `${JSON.stringify({ apiVersion, appVersion: APP_VERSION, typescriptVersion: ts.version, sdkDigest: SDK_DIGEST, files }, null, 2)}\n`);
  await writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { apiVersion, sdkDigest: SDK_DIGEST, sdkDirectory, configPath };
}
