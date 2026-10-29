import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { ProjectRuntime, TrustStore } from "../../src/core";
import type { CompiledLocalComponent, DashboardConfig, ProjectSnapshot } from "../../src/shared/contracts";
import { createProject, removeTemporaryDirectory, temporaryDirectory, waitFor, writeLocalComponent } from "../core/helpers";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let browser: Browser | undefined;
let server: FixtureServer | undefined;
let fixtureUrl = "";

beforeAll(async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!;
  reservation.stop(true);
  fixtureUrl = `http://127.0.0.1:${port}/ui-harness.html`;
  server = startFixtureServer({
    cmd: ["bun", "./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    url: fixtureUrl,
  });
  await server.ready;
  browser = await chromium.launch({
    executablePath: process.env.DASH_BORED_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    timeout: 15_000,
  });
}, 30_000);

afterAll(async () => {
  try { await browser?.close(); }
  finally { await server?.stop(); }
}, 30_000);

interface LifecycleProbe {
  refresh(): string | undefined;
  update(component: CompiledLocalComponent): void;
  unmount(): void;
}

type ProbeWindow = Window & { __localCssProbe?: LifecycleProbe };

test("Fast Refresh restores component CSS without remounting code and failed revisions retain prior CSS", async () => {
  const page = await browser!.newPage();
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(fixtureUrl);
    await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
    await page.evaluate(async (cwd) => {
      // Use the same Vite refresh runtime as source HMR, without editing files
      // shared by the app or other concurrent verification.
      const reactDomUrl = `/@fs${cwd}/node_modules/.vite/deps/react-dom_client.js`;
      const refreshUrl = "/@react-refresh";
      const loaderUrl = "/render/local-components.tsx";
      const reactDomModule = await import(reactDomUrl);
      const { createRoot } = reactDomModule.default ?? reactDomModule;
      const refresh = await import(refreshUrl);
      const { useLocalComponents } = await import(loaderUrl);
      const React = globalThis.__DASH_BORED_COMPONENT_RUNTIME__!.React;
      let generation = 0;
      let components: CompiledLocalComponent[] = [{
        componentId: "css-lifecycle-proof", revision: "one",
        css: ".css-lifecycle-proof { color: rgb(1, 2, 3); }",
        javascript: `export default function Proof() {
          const R = globalThis.__DASH_BORED_COMPONENT_RUNTIME__.React;
          const [count, setCount] = R.useState(0);
          return R.createElement("button", { className: "css-lifecycle-proof", onClick: () => setCount(count + 1) }, "CSS proof " + count);
        }`,
      }];
      function Probe() {
        const loaded = useLocalComponents(components, "css-lifecycle-scope");
        React.useEffect(() => { document.documentElement.dataset.cssProofRefresh = String(generation); }, []);
        const component = loaded.get("css-lifecycle-proof");
        return React.createElement(React.Fragment, null,
          component?.component ? React.createElement(component.component) : null,
          React.createElement("output", { id: "css-lifecycle-error" }, component?.error ?? ""));
      }
      refresh.registerExportsForReactRefresh("css-lifecycle-proof", { Probe });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      root.render(React.createElement(Probe));
      let CurrentProbe = Probe;
      (window as ProbeWindow).__localCssProbe = {
        refresh() {
          generation += 1;
          function UpdatedProbe() {
            const loaded = useLocalComponents(components, "css-lifecycle-scope");
            React.useEffect(() => { document.documentElement.dataset.cssProofRefresh = String(generation); }, []);
            const component = loaded.get("css-lifecycle-proof");
            return React.createElement(React.Fragment, null,
              component?.component ? React.createElement(component.component) : null,
              React.createElement("output", { id: "css-lifecycle-error" }, component?.error ?? ""));
          }
          refresh.registerExportsForReactRefresh("css-lifecycle-proof", { Probe: UpdatedProbe });
          const reason = refresh.validateRefreshBoundaryAndEnqueueUpdate(
            "css-lifecycle-proof", { Probe: CurrentProbe }, { Probe: UpdatedProbe },
          );
          CurrentProbe = UpdatedProbe;
          return reason;
        },
        update(component) { components = [component]; root.render(React.createElement(CurrentProbe)); },
        unmount() { root.unmount(); container.remove(); },
      };
    }, process.cwd());

    const proof = page.locator(".css-lifecycle-proof");
    await proof.waitFor();
    await proof.click();
    expect(await proof.textContent()).toBe("CSS proof 1");
    expect(await proof.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
    expect(await page.evaluate(() => (window as ProbeWindow).__localCssProbe!.refresh())).toBeUndefined();
    // Refresh is debounced; its effect replay must finish before checking CSS.
    await page.waitForFunction(() => document.documentElement.dataset.cssProofRefresh === "1");
    expect(await proof.textContent()).toBe("CSS proof 1");
    expect(await proof.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
    expect(await page.locator('style[data-dash-bored-component^="dash-bored-component:css-lifecycle-proof:"]').count()).toBe(1);

    await page.evaluate(() => (window as ProbeWindow).__localCssProbe!.update({
      componentId: "css-lifecycle-proof", revision: "broken",
      javascript: "export default {};", css: ".css-lifecycle-proof { color: rgb(9, 8, 7); }",
    }));
    await page.locator("#css-lifecycle-error").getByText("does not have a component default export", { exact: false }).waitFor();
    expect(await proof.textContent()).toBe("CSS proof 1");
    expect(await proof.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
    expect(await page.locator('style[data-dash-bored-component$=":broken"]').count()).toBe(0);

    // Effect replay must restore the older successful stylesheet, rather than
    // installing the failing desired revision's CSS.
    expect(await page.evaluate(() => (window as ProbeWindow).__localCssProbe!.refresh())).toBeUndefined();
    await page.waitForFunction(() => document.documentElement.dataset.cssProofRefresh === "2");
    await page.locator("#css-lifecycle-error").getByText("does not have a component default export", { exact: false }).waitFor();
    expect(await proof.textContent()).toBe("CSS proof 1");
    expect(await proof.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
    expect(await page.locator('style[data-dash-bored-component$=":broken"]').count()).toBe(0);

    await page.evaluate(() => (window as ProbeWindow).__localCssProbe!.unmount());
    expect(await page.locator('style[data-dash-bored-component^="dash-bored-component:css-lifecycle-proof:"]').count()).toBe(0);
  } finally { await page.close(); }
}, 20_000);


test("config and lock watcher reloads preserve mounted component CSS and state", async () => {
  const root = await temporaryDirectory();
  const page = await browser!.newPage();
  page.setDefaultTimeout(5_000);
  const snapshots: ProjectSnapshot[] = [];
  const runtime = new ProjectRuntime({
    trustStore: new TrustStore(join(root, ".state", "trust.json")),
    watchDebounceMs: 20,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  try {
    const config: DashboardConfig = {
      schemaVersion: 4, name: "Watcher CSS proof",
      root: { id: "watcher-proof", component: "./components/watcher-css-proof" },
    };
    await createProject(root, config);
    await writeLocalComponent(root, "watcher-css-proof", `
      import { defineComponent, useState } from "@dash-bored/component";
      import "./style.css";
      export default defineComponent(() => {
        const [count, setCount] = useState(0);
        return <button className="watcher-css-proof" onClick={() => setCount(count + 1)}>Watcher proof {count}</button>;
      });
    `, { css: ".watcher-css-proof { color: rgb(1, 2, 3); }" });
    await runtime.load(root);
    const initial = await runtime.trust();
    expect(initial.diagnostics).toEqual([]);
    expect(initial.components).toHaveLength(1);
    const initialRevision = initial.components[0]!.revision;
    runtime.watch();

    await page.goto(fixtureUrl);
    await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
    await page.evaluate(async ({ cwd, snapshot }) => {
      const reactDomUrl = `/@fs${cwd}/node_modules/.vite/deps/react-dom_client.js`;
      const reactDomModule = await import(reactDomUrl);
      const { createRoot } = reactDomModule.default ?? reactDomModule;
      const loaderUrl = "/render/local-components.tsx";
      const { useLocalComponents } = await import(loaderUrl);
      const React = globalThis.__DASH_BORED_COMPONENT_RUNTIME__!.React;
      let current = snapshot;
      function Probe() {
        const loaded = useLocalComponents(current.components, current.configPath);
        const component = loaded.get("watcher-css-proof");
        return component?.component ? React.createElement(component.component) : null;
      }
      const container = document.createElement("div");
      document.body.append(container);
      const reactRoot = createRoot(container);
      reactRoot.render(React.createElement(Probe));
      (window as Window & { __watcherCssProbe?: { update(snapshot: ProjectSnapshot): void } }).__watcherCssProbe = {
        update(next) { current = next; reactRoot.render(React.createElement(Probe)); },
      };
    }, { cwd: process.cwd(), snapshot: initial });
    const proof = page.locator(".watcher-css-proof");
    await proof.waitFor();
    await proof.click();
    expect(await proof.textContent()).toBe("Watcher proof 1");

    async function renderPublishedSnapshots(after: number): Promise<void> {
      for (const snapshot of snapshots.slice(after)) {
        expect(snapshot.diagnostics).toEqual([]);
        expect(snapshot.components).toHaveLength(1);
        await page.evaluate((next) => {
          (window as Window & { __watcherCssProbe?: { update(snapshot: ProjectSnapshot): void } }).__watcherCssProbe!.update(next);
        }, snapshot);
        // Let React commit and passive effects run before checking ownership.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await proof.textContent()).toBe("Watcher proof 1");
        expect(await proof.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
        expect(await page.locator('style[data-dash-bored-component^="dash-bored-component:watcher-css-proof:"]').count()).toBe(1);
      }
    }

    // Exercise actual filesystem notifications, not explicit runtime.reload().
    // Retry saves to allow macOS FSEvents to attach its initial stream.
    for (let round = 0; round < 3; round += 1) {
      const beforeConfig = snapshots.length;
      const name = `Watcher CSS proof ${round}`;
      for (let attempt = 0; attempt < 20 && runtime.getSnapshot().dashboardName !== name; attempt += 1) {
        await writeFile(join(root, ".dash-bored", "dash-bored.yaml"), stringify({ ...config, name }));
        await waitFor(() => runtime.getSnapshot().dashboardName === name, 1_000).catch(() => undefined);
      }
      expect(runtime.getSnapshot().dashboardName).toBe(name);
      await renderPublishedSnapshots(beforeConfig);

      const beforeLock = snapshots.length;
      await writeFile(join(root, ".dash-bored", "dash-bored-lock.yaml"), stringify({ lockfileVersion: 1, components: {} }) + `# save ${round}\n`);
      await waitFor(() => snapshots.length > beforeLock, 5_000);
      await renderPublishedSnapshots(beforeLock);
      expect(runtime.getSnapshot().components[0]!.revision).toBe(initialRevision);
    }

    // A real CSS-only watcher edit must publish a new revision and replace the
    // stylesheet, rather than leaving the old revision cached indefinitely.
    await writeFile(join(root, ".dash-bored", "components", "watcher-css-proof", "style.css"),
      ".watcher-css-proof { color: rgb(9, 8, 7); }");
    await waitFor(() => runtime.getSnapshot().components[0]?.revision !== initialRevision, 5_000);
    const changed = runtime.getSnapshot();
    expect(changed.diagnostics).toEqual([]);
    expect(changed.components).toHaveLength(1);
    expect(changed.components[0]!.javascript).toBe(initial.components[0]!.javascript);
    await page.evaluate((next) => {
      (window as Window & { __watcherCssProbe?: { update(snapshot: ProjectSnapshot): void } }).__watcherCssProbe!.update(next);
    }, changed);
    await page.waitForFunction(() => {
      const element = document.querySelector(".watcher-css-proof");
      return element && getComputedStyle(element).color === "rgb(9, 8, 7)";
    });
    await page.waitForFunction(() => document.querySelectorAll('style[data-dash-bored-component^="dash-bored-component:watcher-css-proof:"]').length === 1);
    expect(await page.locator(`style[data-dash-bored-component$=":${changed.components[0]!.revision}"]`).count()).toBe(1);
  } finally {
    await runtime.close();
    await page.close();
    await removeTemporaryDirectory(root);
  }
}, 40_000);
