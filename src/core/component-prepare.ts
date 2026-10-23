import ts from "typescript";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { CoreError } from "./diagnostics";
import { writeFileAtomically } from "./fs-atomic";
import { isPathContained, resolveContainedPath } from "./paths";

/** Vendor an author-installed browser dependency; consumers only need the committed output. */
export async function prepareComponentDependency(
  directory: string,
  options: { dependency: string; output: string },
): Promise<{ dependency: string; output: string }> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._/-]+)?$/i.test(options.dependency)
    || options.dependency.split("/").includes("..")) {
    throw new CoreError("COMPONENT_PREPARE_DEPENDENCY", "Specify an installed npm package or package subpath.");
  }
  if (!options.output.endsWith(".js")) throw new CoreError("COMPONENT_PREPARE_OUTPUT", "Dependency output must be a relative .js file.");
  const root = await realpath(resolve(directory));
  const output = await resolveContainedPath(root, options.output, { mustExist: false });
  // Let the browser bundler select package exports/browser mappings. The runtime
  // resolver selects Node conditions and would turn browser-only packages into
  // the wrong dependency before bundling even starts.
  const probePath = join(root, ".dash-bored-dependency-probe.js");
  let entry: string | undefined;
  const probe = await Bun.build({
    entrypoints: [probePath], target: "browser", format: "esm",
    plugins: [{ name: "component-browser-entry", setup(build) {
      build.onResolve({ filter: /\.dash-bored-dependency-probe\.js$/ }, (args) => args.importer === "" ? { path: probePath } : undefined);
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        if (args.path === probePath) return { contents: `export * from ${JSON.stringify(options.dependency)};`, loader: "js" };
        entry = args.path;
        // Resolve only the public entry; do not build its graph twice.
        return { contents: "export {};", loader: "js" };
      });
    } }],
  });
  if (!probe.success || !entry) throw new CoreError("COMPONENT_PREPARE_FAILED", probe.logs.map((item) => item.message).join("\n") || "Cannot resolve the browser package entry.");
  // A facade also avoids Bun dropping the body of packages whose entry only re-exports.
  const source = await Bun.file(entry).text();
  const extension = extname(entry).toLowerCase();
  const loader = [".ts", ".mts", ".cts"].includes(extension) ? "ts" : extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : "js";
  const scriptKind = loader === "ts" ? ts.ScriptKind.TS : loader === "tsx" ? ts.ScriptKind.TSX : loader === "jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const exports = new Bun.Transpiler({ loader }).scan(source).exports;
  const commonJs = !ts.isExternalModule(ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, false, scriptKind));
  const hasDefault = commonJs || exports.includes("default");
  const facade = `export * from ${JSON.stringify(entry)};${hasDefault ? `export { default } from ${JSON.stringify(entry)};` : ""}`;
  const result = await Bun.build({
    entrypoints: ["dash-bored-dependency:entry"], target: "browser", format: "esm", splitting: false,
    jsx: { runtime: "automatic", importSource: "react", development: false },
    external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@dash-bored/component"],
    sourcemap: "none", minify: false,
    plugins: [{ name: "component-dependency-entry", setup(build) {
      build.onResolve({ filter: /^dash-bored-dependency:entry$/ }, () => ({ path: "entry", namespace: "component-dependency" }));
      build.onLoad({ filter: /.*/, namespace: "component-dependency" }, () => ({ contents: facade, loader: "js" }));
    } }],
  });
  if (!result.success) throw new CoreError("COMPONENT_PREPARE_FAILED", result.logs.map((item) => item.message).join("\n"));
  if (result.outputs.length !== 1 || !result.outputs[0]!.path.endsWith(".js")) {
    throw new CoreError("COMPONENT_PREPARE_OUTPUT", "Dependency must produce one self-contained browser JavaScript file; asset and CSS outputs are unsupported.");
  }
  // Bun labels each bundled module with its path relative to the working
  // directory; relabel against the package so output is the same from anywhere.
  const contents = (await result.outputs[0]!.text()).replace(/^\/\/ (\S[^\n]*)$/gm, (line, label: string) => {
    const path = resolve(process.cwd(), label);
    return isPathContained(root, path) && existsSync(path) ? `// ${relative(root, path).replaceAll("\\", "/")}` : line;
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFileAtomically(output, contents, {
    beforePublish: async () => { await resolveContainedPath(root, options.output, { mustExist: false }); },
  });
  return { dependency: options.dependency, output };
}
