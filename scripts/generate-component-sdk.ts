import ts from "typescript";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { COMPONENT_REACT_EXPORTS, COMPONENT_RUNTIME_EXPORTS, REACT_RUNTIME_EXPORTS } from "../src/shared/component-api";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src/component-api/generated");
const check = process.argv.includes("--check");
const emitted = new Map<string, string>();
const program = ts.createProgram([resolve(root, "src/component-api/index.ts")], {
  declaration: true, emitDeclarationOnly: true, outDir: output, rootDir: resolve(root, "src"),
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
  esModuleInterop: true, types: [],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => "\n",
}));
program.emit(undefined, (path, contents) => emitted.set(path, contents));
const checker = program.getTypeChecker();
const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(resolve(root, "src/component-api/index.ts"))!);
if (!moduleSymbol) throw new Error("Public API is not a module.");
const ambientExports = checker.getExportsOfModule(moduleSymbol).flatMap((exported) => {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const name = exported.name;
  const declarations = symbol.declarations ?? [];
  const typeDeclaration = declarations.find((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node));
  const parameters = typeDeclaration && (ts.isInterfaceDeclaration(typeDeclaration) || ts.isTypeAliasDeclaration(typeDeclaration)) ? typeDeclaration.typeParameters ?? [] : [];
  const generic = parameters.length ? `<${parameters.map((parameter) => parameter.getText()).join(", ")}>` : "";
  const args = parameters.length ? `<${parameters.map((parameter) => parameter.name.text).join(", ")}>` : "";
  return [
    ...(symbol.flags & ts.SymbolFlags.Type ? [`  export type ${name}${generic} = import("../component-api/index").${name}${args};`] : []),
    ...(symbol.flags & ts.SymbolFlags.Value ? [`  export const ${name}: typeof import("../component-api/index").${name};`] : []),
  ];
});
const ambient = `// Generated from the public API; keeps application TypeScript aliases independent of Hutch.\ndeclare module "@dash-bored/component" {\n${ambientExports.join("\n")}\n}\n`;
const ambientPath = resolve(root, "src/types/component-api.d.ts");
if (check) { if (await readFile(ambientPath, "utf8").catch(() => "") !== ambient) throw new Error("Stale application SDK alias."); }
else await writeFile(ambientPath, ambient);
for (const [path, contents] of emitted) {
  if (check) {
    if (await readFile(path, "utf8").catch(() => "") !== contents) throw new Error(`Stale SDK declarations: ${relative(root, path)}`);
  } else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
}

const assets: Array<[string, string]> = [...emitted.keys()].sort().map((path) => [relative(output, path), path]);
const libDirectory = resolve(root, "node_modules/typescript/lib");
for (const name of (await readdir(libDirectory)).sort()) {
  if (/^lib\..*\.d\.ts$/.test(name)) assets.push([`typescript/lib/${name}`, resolve(libDirectory, name)]);
}
for (const [directory, files] of [
  ["@types/react", ["index.d.ts", "global.d.ts", "jsx-runtime.d.ts", "jsx-dev-runtime.d.ts", "LICENSE"]],
  ["@types/prop-types", ["index.d.ts", "LICENSE"]],
  ["csstype", ["index.d.ts", "LICENSE"]],
  ["typescript", ["LICENSE.txt"]],
] as const) {
  for (const file of files) assets.push([`vendor/${directory}/${file}`, resolve(root, `node_modules/${directory}/${file}`)]);
}
const imports = assets.map(([, path], index) =>
  `// @ts-ignore Bun embeds declarations as text, not as TypeScript modules.\nimport asset${index} from ${JSON.stringify(relative(resolve(root, "src/component-api"), path).replaceAll("\\", "/").replace(/^(?!\.)/, "./"))} with { type: "text" };`).join("\n");
const values = assets.map(([key], index) => `  ${JSON.stringify(key)}: asset${index} as unknown as string,`).join("\n");
const reactTypesSource = ts.createSourceFile("react.d.ts", await readFile(resolve(root, "node_modules/@types/react/index.d.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const reactNamespace = reactTypesSource.statements.find((statement) => ts.isModuleDeclaration(statement) && statement.name.getText(reactTypesSource) === "React");
if (!reactNamespace || !ts.isModuleDeclaration(reactNamespace) || !reactNamespace.body || !ts.isModuleBlock(reactNamespace.body)) throw new Error("Cannot find the React type namespace.");
const reactTypeNames = [...new Set(reactNamespace.body.statements.flatMap((statement) =>
  (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name ? [statement.name.getText(reactTypesSource)] : []))];
const facade = `import * as React from "@dash-bored/react-types";\nexport default React;\nexport type { ${reactTypeNames.join(", ")} } from "@dash-bored/react-types";\nexport { ${REACT_RUNTIME_EXPORTS.join(", ")} } from "@dash-bored/react-types";\n`;
// Ambient public modules are visible to editors without redirecting Bun's
// runtime imports to declaration files. Only private type aliases use paths.
const editorModules = `declare module "@dash-bored/component" {
  export * from "@dash-bored/component-types";
}
declare module "react" {
  export * from "@dash-bored/react-facade";
  export { default } from "@dash-bored/react-facade";
}
declare module "react/jsx-runtime" {
  export * from "@dash-bored/react-jsx-types";
}
declare module "react/jsx-dev-runtime" {
  export * from "@dash-bored/react-jsx-dev-types";
}
declare module "csstype" {
  export * from "@dash-bored/css-types";
}
declare module "prop-types" {
  import PropTypes = require("@dash-bored/prop-types");
  export = PropTypes;
}
`;
// Check the hand-written public root re-exports against the compiler's source of truth.
const entry = await readFile(resolve(root, "src/component-api/index.ts"), "utf8");
const source = ts.createSourceFile("index.ts", entry, ts.ScriptTarget.Latest);
const reactExports = source.statements.filter(ts.isExportDeclaration)
  .filter((statement) => statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "react")
  .flatMap((statement) => statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((element) => element.name.text) : []);
if (JSON.stringify(reactExports) !== JSON.stringify([...COMPONENT_REACT_EXPORTS])) throw new Error("Public React exports differ from the runtime contract.");
const referencePath = resolve(root, "skills/dash-bored/references/components.md");
const reference = await readFile(referencePath, "utf8");
const exportMarkers = /<!-- component-sdk-runtime-exports:start -->[\s\S]*?<!-- component-sdk-runtime-exports:end -->/;
if (!exportMarkers.test(reference)) throw new Error("Missing component SDK reference markers.");
const updatedReference = reference.replace(exportMarkers, `<!-- component-sdk-runtime-exports:start -->\n\`@dash-bored/component\` runtime exports: ${COMPONENT_RUNTIME_EXPORTS.map((name) => `\`${name}\``).join(", ")}.\n<!-- component-sdk-runtime-exports:end -->`);
if (check) { if (updatedReference !== reference) throw new Error("Stale skill SDK runtime exports."); }
else if (updatedReference !== reference) await writeFile(referencePath, updatedReference);
const generated = `// Generated by scripts/generate-component-sdk.ts.\n${imports}\nexport const SDK_FILES: Record<string, string> = {\n${values}\n  "index.d.ts": 'export * from "./component-api/index";\\n',\n  "react.d.ts": ${JSON.stringify(facade)},\n  "modules.d.ts": ${JSON.stringify(editorModules)},\n  "css.d.ts": 'declare module "*.css" {}\\n',\n};\n`;
const payloadPath = resolve(root, "src/component-api/assets.generated.ts");
if (check) {
  if (await readFile(payloadPath, "utf8").catch(() => "") !== generated) throw new Error("Stale SDK asset imports.");
} else await writeFile(payloadPath, generated);
