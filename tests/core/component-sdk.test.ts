import { afterEach, describe, expect, test } from "bun:test";
import ts from "typescript";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkComponentDirectory,
  componentApiInfo,
  createComponentTypeScriptHost,
  SDK_DIGEST,
  sdkCompilerPaths,
  setupComponentAuthoring,
} from "../../src/core/component-authoring";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(name: string, manifest: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), `dash-bored-sdk-${name}-`));
  temporaryDirectories.push(root);
  const component = join(root, "components", name);
  await mkdir(component, { recursive: true });
  await writeFile(join(component, "component.yaml"), [
    "schemaVersion: 3",
    ...(manifest.apiVersion === null ? [] : [`apiVersion: ${String(manifest.apiVersion ?? "1.0.0")}`]),
    `id: ${name}`,
    `name: ${name}`,
    "description: Component SDK test fixture.",
    `entry: ${String(manifest.entry ?? "./index.tsx")}`,
    ...(manifest.types === undefined ? [] : [`types: ${String(manifest.types)}`]),
    "propsSchema:",
    "  type: object",
    "  additionalProperties: false",
    "  properties:",
    "    endpoint:",
    "      type: string",
    "children:",
    "  min: 0",
    "  max: 0",
    "  presentation:",
    "    type: tiled",
    "    axes: both",
    "permissions:",
    "  - network:http",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(component, "index.tsx"), "export default function Component() { return null; }\n", "utf8");
  return { root, component };
}

function diagnosticCodes(result: Awaited<ReturnType<typeof checkComponentDirectory>>) {
  return result.diagnostics.map((item) => item.code);
}

describe("component authoring SDK", () => {
  test("requires a supported API target before component compilation", async () => {
    for (const [name, apiVersion, expected] of [
      ["missing-api", null, "COMPONENT_API_REQUIRED"],
      ["unsupported-api", "9.0.0", "COMPONENT_API_UNSUPPORTED"],
    ] as const) {
      const { component } = await fixture(name, { ...(apiVersion === undefined ? {} : { apiVersion }) });
      const result = await checkComponentDirectory(component);
      expect(result.ok).toBeFalse();
      expect(diagnosticCodes(result)).toContain(expected);
      expect(result.stages.some((stage) => stage.name === "production-bundle")).toBeFalse();
    }
  }, { timeout: 15_000 });

  test("semantically rejects an invalid host response field and an unknown SDK export", async () => {
    const { component } = await fixture("bad-contract");
    await writeFile(join(component, "index.tsx"), `
import { defineComponent } from "@dash-bored/component";
import type { MissingSdkType } from "@dash-bored/component";
interface Props { endpoint: string }
export default defineComponent<Props>(({ props, host }) => {
  type BrokenSdkContract = MissingSdkType;
  void host.http?.request({ url: props.endpoint }).then((response) => response.ok);
  return null;
});
`, "utf8");

    const result = await checkComponentDirectory(component);
    const messages = result.diagnostics.map((item) => item.message).join("\n");
    expect(result.ok).toBeFalse();
    expect(diagnosticCodes(result).some((code) => code.startsWith("COMPONENT_TYPESCRIPT_"))).toBeTrue();
    expect(messages).toContain("MissingSdkType");
    expect(messages).toContain("ok");
    expect(result.stages.find((stage) => stage.name === "production-bundle")?.status).toBe("passed");
  }, { timeout: 15_000 });

  test("production bundle rejects imports that escape the component directory", async () => {
    const { root, component } = await fixture("escaping-import");
    await writeFile(join(root, "outside.ts"), "export const outside = true;\n", "utf8");
    await writeFile(join(component, "index.tsx"), `import { outside } from "../../outside"; export default () => <div>{String(outside)}</div>;\n`, "utf8");

    const result = await checkComponentDirectory(component);
    expect(result.ok).toBeFalse();
    expect(result.diagnostics.some((item) => item.code === "COMPONENT_COMPILE_FAILED" && item.message.includes("resolves outside the component directory"))).toBeTrue();
    expect(result.stages.find((stage) => stage.name === "production-bundle")?.status).toBe("failed");
  }, { timeout: 15_000 });

  test("checks a JavaScript artifact against its declared default component interface", async () => {
    const { component } = await fixture("bad-javascript-types", { entry: "./dist/index.js", types: "./types.d.ts" });
    await mkdir(join(component, "dist"), { recursive: true });
    await writeFile(join(component, "dist/index.js"), "export default function Component() { return null; }\n", "utf8");
    await writeFile(join(component, "types.d.ts"), "declare const Component: (props: { wrong: string }) => null; export default Component;\n", "utf8");

    const result = await checkComponentDirectory(component);
    expect(result.ok).toBeFalse();
    expect(diagnosticCodes(result).some((code) => code.startsWith("COMPONENT_TYPESCRIPT_"))).toBeTrue();
    expect(result.stages.find((stage) => stage.name === "declaration-interface")?.status).toBe("failed");
  }, { timeout: 15_000 });

  test("setup preserves project TypeScript settings and refuses locally modified SDK files", async () => {
    const { component } = await fixture("setup-preserves");
    const configPath = join(component, "tsconfig.json");
    const originalConfig = {
      compilerOptions: { target: "ES2020", paths: { "@project/*": ["./src/*"] } },
      include: ["src/**/*.ts"],
    };
    await writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, "utf8");

    const setup = await setupComponentAuthoring(component);
    const configured = JSON.parse(await readFile(configPath, "utf8"));
    expect(configured.compilerOptions.target).toBe("ES2020");
    expect(configured.compilerOptions.paths["@project/*"]).toEqual(["./src/*"]);
    expect(configured.include).toEqual(["src/**/*.ts"]);
    expect(configured.compilerOptions.paths["@dash-bored/component-types"]).toEqual(["./.dash-bored-sdk/index.d.ts"]);
    expect(configured.compilerOptions.paths.react).toBeUndefined();

    const editedSdkFile = join(setup.sdkDirectory, "index.d.ts");
    await writeFile(editedSdkFile, `${await readFile(editedSdkFile, "utf8")}// local edit\n`, "utf8");
    const configBeforeRefusal = await readFile(configPath, "utf8");
    await expect(setupComponentAuthoring(component)).rejects.toMatchObject({ code: "COMPONENT_SDK_MODIFIED" });
    expect(await readFile(configPath, "utf8")).toBe(configBeforeRefusal);
    expect(await readFile(editedSdkFile, "utf8")).toEndWith("// local edit\n");
  }, { timeout: 15_000 });

  test("setup preserves inherited aliases with and without a baseUrl", async () => {
    for (const baseUrl of [undefined, "src"]) {
      const { component } = await fixture(`setup-inherited-${baseUrl ?? "no-base"}`);
      const baseDirectory = join(component, "config");
      await mkdir(join(baseDirectory, "src"), { recursive: true });
      const projectType = join(baseDirectory, "src/model.ts");
      await writeFile(projectType, "export type Model = string;\n");
      await writeFile(join(baseDirectory, "base.json"), JSON.stringify({ files: ["src/model.ts"], compilerOptions: {
        baseUrl, paths: { "@project/model": [baseUrl ? "./model.ts" : "./src/model.ts"] },
        target: "ES2022", moduleResolution: "Bundler", module: "ESNext", jsx: "react-jsx",
      } }));
      const configPath = join(component, "tsconfig.json");
      await writeFile(configPath, JSON.stringify({ extends: "./config/base.json", include: ["index.tsx"] }));
      await setupComponentAuthoring(component);
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, component, undefined, configPath);
      expect(parsed.fileNames).toContain(projectType);
      expect(ts.resolveModuleName("@project/model", join(component, "index.tsx"), parsed.options, ts.sys).resolvedModule?.resolvedFileName).toBe(projectType);
      expect(ts.resolveModuleName("@dash-bored/component-types", join(component, "index.tsx"), parsed.options, ts.sys).resolvedModule?.resolvedFileName).toBe(join(component, ".dash-bored-sdk/index.d.ts"));
      const configured = await readFile(configPath, "utf8");
      await setupComponentAuthoring(component);
      expect(await readFile(configPath, "utf8")).toBe(configured);
    }
  }, { timeout: 15_000 });

  test("setup and migration preserve Bun React imports without runtime mocks", async () => {
    const { component } = await fixture("runtime-resolution");
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(component, "node_modules"));
    const runtimeSource = join(component, "runtime.tsx");
    await writeFile(runtimeSource, `import { createElement } from "react";\nimport { jsx } from "react/jsx-runtime";\nconsole.log(createElement("span").type, jsx("div", {}).type);\n`);
    const run = async () => {
      const child = Bun.spawn([process.execPath, runtimeSource], { cwd: component, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("span div");
    };
    await run();
    const setup = await setupComponentAuthoring(component);
    await run();
    // Simulate the earlier SDK's tsconfig, preserving its installation receipt.
    const config = JSON.parse(await readFile(setup.configPath, "utf8"));
    config.compilerOptions.paths = { ...config.compilerOptions.paths, ...Object.fromEntries(
      Object.entries(sdkCompilerPaths(setup.sdkDirectory)).map(([name, paths]) => [name, paths.map((path) => `./${relative(dirname(setup.configPath), path)}`)]),
    ) };
    await writeFile(setup.configPath, JSON.stringify(config));
    await setupComponentAuthoring(component);
    const migrated = JSON.parse(await readFile(setup.configPath, "utf8"));
    expect(migrated.compilerOptions.paths.react).toBeUndefined();
    expect(migrated.compilerOptions.paths["react/jsx-runtime"]).toBeUndefined();
    await run();
    // A user-owned runtime alias is unrelated configuration and stays intact.
    migrated.compilerOptions.paths.react = ["./node_modules/react"];
    await writeFile(setup.configPath, JSON.stringify(migrated));
    await setupComponentAuthoring(component);
    expect(JSON.parse(await readFile(setup.configPath, "utf8")).compilerOptions.paths.react).toEqual(["./node_modules/react"]);
    await run();
  }, { timeout: 15_000 });

  test("installed SDK tsconfig powers a language service without source aliases or node_modules", async () => {
    const { component } = await fixture("language-service");
    const sourcePath = join(component, "index.tsx");
    const source = `
import { defineComponent } from "@dash-bored/component";
interface Props { endpoint: string }
export default defineComponent<Props>(({ props, host }) => {
  void host.http;
  void host.filesystem?.readText;
  host.actions.register({ id: "refresh", label: "Refresh", run: async () => {
    const endpoint = props.endpoint;
    await host.http?.request({ url: endpoint });
  } });
  return <div>{props.endpoint}</div>;
});
`;
    await writeFile(sourcePath, source, "utf8");
    const setup = await setupComponentAuthoring(component);
    expect(await Bun.file(join(component, "node_modules")).exists()).toBeFalse();

    const apiInfo = componentApiInfo();
    const sdkRoot = setup.sdkDirectory;
    expect(apiInfo.apiVersion).toBe("1.0.0");
    expect(setup.sdkDigest).toBe(SDK_DIGEST);
    expect(JSON.parse(await readFile(join(sdkRoot, "sdk-version.json"), "utf8")).sdkDigest).toBe(SDK_DIGEST);
    expect(sdkCompilerPaths(sdkRoot)["@dash-bored/component"]).toEqual([join(sdkRoot, "index.d.ts")]);
    const installedSdkHost = createComponentTypeScriptHost(sdkRoot, { strict: true });
    expect(installedSdkHost.fileExists(join(sdkRoot, "index.d.ts"))).toBeTrue();
    expect(installedSdkHost.readFile(join(sdkRoot, "index.d.ts"))).toContain("./component-api/index");

    const config = ts.readConfigFile(setup.configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, component);
    expect(parsed.fileNames).toContain(sourcePath);
    expect(parsed.options.paths?.["@dash-bored/component-types"]).toEqual(["./.dash-bored-sdk/index.d.ts"]);
    const versions = new Map<string, { version: number; text: string }>([[sourcePath, { version: 0, text: source }]]);
    const languageService = ts.createLanguageService({
      getCompilationSettings: () => parsed.options,
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: (file) => String(versions.get(file)?.version ?? 0),
      getScriptSnapshot: (file) => {
        const virtual = versions.get(file)?.text;
        const text = virtual ?? ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => component,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    }, ts.createDocumentRegistry());

    const hostCompletion = languageService.getCompletionsAtPosition(sourcePath, source.indexOf("host.http") + "host.".length, {});
    expect(hostCompletion?.entries.map((entry) => entry.name)).toContain("filesystem");
    expect(hostCompletion?.entries.map((entry) => entry.name)).toContain("actions");
    const filesystemPosition = source.indexOf("host.filesystem?.readText") + "host.filesystem?.".length;
    const filesystemCompletion = languageService.getCompletionsAtPosition(sourcePath, filesystemPosition, {});
    expect(filesystemCompletion?.entries.map((entry) => entry.name)).toContain("readText");

    const endpointPosition = source.indexOf("endpoint = props.endpoint") + "endpoint = props.".length;
    const endpointInfo = languageService.getQuickInfoAtPosition(sourcePath, endpointPosition);
    expect(endpointInfo?.displayParts?.map((part) => part.text).join("")).toContain("string");
    const handlerPosition = source.indexOf("run: async") + 1;
    const handlerInfo = languageService.getQuickInfoAtPosition(sourcePath, handlerPosition);
    expect(handlerInfo?.displayParts?.map((part) => part.text).join("")).toContain("Promise<void>");
    expect(languageService.getSemanticDiagnostics(sourcePath)).toEqual([]);
    expect(ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))).toEqual([]);
    languageService.dispose();
  }, { timeout: 15_000 });
});
