import { afterAll, beforeAll, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";
import { compileLocalComponents } from "../../src/core/compiler";
import type { LocalComponentDefinition } from "../../src/core/tree-catalog";

let outputDirectory: string | undefined;
let server: FixtureServer | undefined;
let browser: Browser | undefined;
let fixtureUrl = "";

beforeAll(async () => {
  const executablePath = process.env.DASH_BORED_BROWSER_EXECUTABLE
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(executablePath);
  outputDirectory = await mkdtemp(join(tmpdir(), "dash-bored-production-"));
  const build = Bun.spawn(["bun", "--eval", `
    import { build, mergeConfig } from "vite";
    import config from "./vite.config";
    await build(mergeConfig(config, {
      // Enable the inert fixture host only in this test build. React and JSX
      // still use production transforms and NODE_ENV=production.
      plugins: [{ name: "production-component-proof-host", enforce: "pre",
        transform(source, id) {
          if (id.endsWith("/src/renderer/lib/rpc-client.ts")) {
            return source.replace("if (import.meta.env.PROD) return Promise.resolve();", "");
          }
        },
      }],
      build: {
        outDir: process.env.DASH_BORED_PRODUCTION_TEST_OUT_DIR,
        rollupOptions: { input: "src/renderer/ui-harness.html" },
      },
    }));
  `], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NODE_ENV: "production", DASH_BORED_PRODUCTION_TEST_OUT_DIR: outputDirectory },
  });
  const [code, stdout, stderr] = await Promise.all([
    build.exited, new Response(build.stdout).text(), new Response(build.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Production renderer build failed (${code}).\n${stdout}\n${stderr}`);
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!;
  reservation.stop(true);
  fixtureUrl = `http://127.0.0.1:${port}/ui-harness.html`;
  server = startFixtureServer({
    cmd: ["bun", "./node_modules/vite/bin/vite.js", "preview", "--outDir", outputDirectory,
      "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    url: fixtureUrl,
  });
  await server.ready;
  browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

test("production renderer mounts pinned core components and switches button/selection panels", async () => {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(fixtureUrl);
    await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
    expect(await page.evaluate(() => {
      const runtime = window.__DASH_BORED_COMPONENT_RUNTIME__!;
      const internals = (runtime.React as unknown as Record<string, Record<string, unknown>>)
        .__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED!;
      return "ReactDebugCurrentFrame" in internals;
    })).toBe(false);
    await page.getByText("Fixture status", { exact: true }).waitFor();
    await page.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: "Production components", root: {
        id: "root", component: "./components/external/core/group", children: {
          axis: "vertical",
          first: { node: { id: "navigation", component: "./components/external/core/button",
            props: { variant: "tabs", items: [
              { name: "Overview", action: "select:panels/overview" },
              { name: "Details", action: "select:panels/details" },
            ] } } },
          second: { node: { id: "panels", component: "./components/external/core/selection",
            props: { defaultChild: "overview" }, children: [
              { metadata: { label: "Overview" }, node: { id: "overview",
                component: "./components/external/core/markdown", props: { content: "Production overview works" } } },
              { metadata: { label: "Details" }, node: { id: "details",
                component: "./components/external/core/markdown", props: { content: "Production details work" } } },
            ] } },
        },
      } }, snapshot.configRevision!);
    });
    await page.getByText("Production overview works", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await page.getByText("Production details work", { exact: true }).waitFor();
    expect(await page.getByText("Production overview works", { exact: true }).count()).toBe(0);
    expect(await page.getByText(/crashed/).count()).toBe(0);
    expect(errors).toEqual([]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nPage errors: ${errors.join("; ")}\n${await page.locator("body").innerText()}`);
  } finally {
    await page.close();
  }
}, 20_000);

test("local TSX and published jsxDEV calls preserve fragments, keys and children in production", async () => {
  const sources = [
    { id: "automatic-jsx", source: 'export default () => <><span key="left">left</span><span key="right">right</span></>;' },
    { id: "published-jsx-dev", source: `import { Fragment, jsxDEV } from "react/jsx-dev-runtime";
      export default () => jsxDEV(Fragment, { children: [
        jsxDEV("span", { children: "left" }, "left", false, undefined, undefined),
        jsxDEV("span", { children: "right" }, "right", false, undefined, undefined),
      ] }, "root", true, undefined, undefined);` },
  ];
  const definitions: LocalComponentDefinition[] = [];
  for (const { id, source } of sources) {
    const directory = join(outputDirectory!, id);
    await mkdir(directory);
    const entryPath = join(directory, "index.tsx");
    await writeFile(entryPath, source);
    await writeFile(join(directory, "tsconfig.json"), '{"compilerOptions":{"jsx":"react-jsxdev"}}');
    definitions.push({ directory, entryPath, manifestPath: join(directory, "component.yaml"),
      reference: `./components/${id}`, manifest: { schemaVersion: 3, apiVersion: "1.0.0",
        id, name: id, description: "Production JSX proof", entry: "./index.tsx", propsSchema: { type: "object" } },
    });
  }
  const compiled = await compileLocalComponents(definitions);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.components).toHaveLength(2);
  // Even a component tsconfig requesting jsxDEV must compile with production JSX.
  expect(compiled.components.find((component) => component.componentId === "automatic-jsx")!.javascript).not.toContain("jsxDEV");
  const page = await browser!.newPage();
  try {
    await page.goto(fixtureUrl);
    await page.getByText("Fixture status", { exact: true }).waitFor();
    const elements = await page.evaluate(async (components) => {
      const results = [];
      for (const component of components) {
        const url = URL.createObjectURL(new Blob([component.javascript], { type: "text/javascript" }));
        try {
          const { default: render } = await import(url);
          const element = render();
          results.push({ id: component.componentId,
            fragment: element.type === window.__DASH_BORED_COMPONENT_RUNTIME__!.React.Fragment,
            key: element.key,
            children: element.props.children.map((child: { type: string; key: string; props: { children: string } }) =>
              ({ type: child.type, key: child.key, text: child.props.children })),
          });
        } finally { URL.revokeObjectURL(url); }
      }
      return results;
    }, compiled.components);
    expect(elements).toEqual(sources.map(({ id }) => ({ id, fragment: true,
      key: id === "automatic-jsx" ? null : "root", children: [
        { type: "span", key: "left", text: "left" },
        { type: "span", key: "right", text: "right" },
      ],
    })));
  } finally { await page.close(); }
}, 20_000);
