import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import type { ComponentNode, ComponentChildLayout } from "../../src/shared/contracts";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let fixtureServer: FixtureServer | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let fixtureUrl = "";

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new Error("Could not reserve a renderer fixture port.");
  return port;
}

// Keep each Playwright wait inside its test's budget. A wait that outlives
// the test makes Bun kill the shared Chrome as a dangling process, so every
// later test fails with "browser has been closed" instead of the real error.
const PAGE_TIMEOUT_MS = 10_000;

async function openPage(options?: Parameters<Browser["newPage"]>[0]): Promise<Page> {
  const opened = await browser!.newPage(options);
  opened.setDefaultTimeout(PAGE_TIMEOUT_MS);
  return opened;
}

function currentPage(): Page {
  if (!page) throw new Error("Renderer interaction page is unavailable.");
  return page;
}

async function addGroupDraft(active: Page = currentPage()): Promise<void> {
  await active.getByRole("button", { name: "Open component library" }).click();
  await active.getByRole("button", { name: "Insert Group", exact: true }).click();
  await active.getByRole("heading", { name: "Add component" }).waitFor();
  await active.getByRole("button", { name: "Add component", exact: true }).click();
  await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
  await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
}

type LibraryDragTraceWindow = Window & { __libraryDragTrace?: string[]; __stopLibraryDragTrace?: () => void };

/*
 * Library drag flake log. Read this before changing the library drag tests.
 *
 * Symptom: on hosted macOS runners (3 CPUs), a component-library drag from
 * "Insert Group" onto renderer-proof-card sometimes never produces a drop,
 * although the same commit passes CI and local runs.
 * - Before a516d01 and 32198ec: fixed by waiting for a valid drop target,
 *   scrolling the target into view, dropping near its bottom edge, and waiting
 *   for the bottom indicator. It kept flaking after both.
 * - Release run 38416165831, attempt 1 (v0.5.2, 2026-10-13): "pointer and
 *   keyboard insertions…" waited 10 s for aria-grabbed="true" and never saw it.
 *   Its save never happened, so the next four tests failed one revision behind
 *   ("ui-harness-5", "Revision 6/7/8"). When that happens, fix the first failure
 *   only.
 * - Same run, attempt 2: "dragging advertises one compatible insertion edge…"
 *   waited 10 s for the bottom drop indicator. The old test never checked that
 *   the drag had started, so this may be the same failure.
 * - CI run 38441977932 on 95d95e4 (the helpers below, first version): the drag
 *   started, reached the target, and dropped; the "Add component" dialog
 *   opened. Then Enter on its submit button never produced the "Dashboard
 *   editor" within 10 s. So the flaky step may be the submit, not the drag.
 *   submitAddComponentWithEnter now reports why the dialog stayed open.
 * - Not reproduced locally: three runs of this file and one full suite with
 *   12-20 busy loops on a 10-core Mac all passed. A probe showed the drawer's
 *   220 ms slide-in had finished and the button's geometry was stable when the
 *   test measured it.
 *
 * Changed after those runs (the helpers below):
 * - Pressing used raw mouse.move/down at a measured point. That skips
 *   Playwright's hit-target check, so anything covering the button at that
 *   moment swallowed the press with no trace. The press now goes through
 *   hover(), which waits until the button is visible, stable, and receives
 *   events. The press point is also hit-tested.
 * - A short move inside the drawer crosses the 6 px activation threshold and
 *   confirms the grab before the pointer travels, so "did not start" and
 *   "found no target" fail separately.
 * - The target is measured again after the drag starts. The tab switch and the
 *   drawer folding can still be settling before then. Drop targets are resolved
 *   only on pointer moves (an elementFromPoint call throttled to animation frames
 *   in composition-targets.ts), so a pointer that stops over a covered or moved
 *   point never gets an indicator.
 * - No retries, on purpose: a retry would hide which step failed.
 *
 * If it fails again, the error carries evidence. Next steps by symptom:
 * - "did not start" with no pointerdown on the button: something covered it.
 *   Find out what, or press the card's data-library-drag-handle instead.
 * - "did not start" with lostpointercapture, pointercancel, or "blur window"
 *   after the pointerdown: the gesture was cancelled. pointer-session.ts
 *   finishes on a window blur, and the drawer folds to pointer-events: none once
 *   a drag starts (CompositionFlyout.tsx). Element blurs, such as the search box
 *   losing focus on the press, are expected.
 * - "did not start" with pointerdown and gotpointercapture but no grab:
 *   movePointerDrag never saw the move. Try more or larger steps.
 * - "found no drop indicator": compare underPointer with the target. If the
 *   pointer is over the target, nudge it 1 px to force another hit test and
 *   record whether that helps. Otherwise, find what covers it.
 * - "Add component stayed open": dialogText holds any apply error
 *   (ComponentDialog's role="alert", for example a drop target that went stale
 *   before the submit). alerts holds app notices such as "Wait for the dashboard
 *   draft check…" from sourceIsReady() in use-composition-session.ts. If both are
 *   empty and focus was on the submit button, the Enter key never submitted the
 *   form.
 */

/** Press a component-library entry and cross the drag threshold, or fail with evidence. */
async function startLibraryDrag(active: Page, source: Locator): Promise<void> {
  await source.hover();
  const box = await source.boundingBox();
  if (!box) throw new Error("Library drag source geometry is unavailable.");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const covering = await source.evaluate((element, { x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit && element.contains(hit) ? null : hit?.outerHTML.slice(0, 160) ?? "nothing";
  }, point);
  if (covering) throw new Error(`Library drag source is covered at its press point by ${covering}`);

  await active.evaluate(() => {
    const trace: string[] = [];
    const record = (event: Event): void => {
      const target = event.target === window ? "window" : event.target instanceof Element
        ? `${event.target.tagName.toLowerCase()}[${event.target.getAttribute("aria-label") ?? ""}].${event.target.getAttribute("class") ?? ""}`
        : String(event.target);
      trace.push(`${Math.round(performance.now())} ${event.type} ${target}`);
    };
    const types = ["pointerdown", "gotpointercapture", "lostpointercapture", "pointercancel", "pointerup", "blur"];
    for (const type of types) window.addEventListener(type, record, true);
    const traced = window as LibraryDragTraceWindow;
    traced.__libraryDragTrace = trace;
    traced.__stopLibraryDragTrace = () => types.forEach((type) => window.removeEventListener(type, record, true));
  });
  try {
    await active.mouse.down();
    await active.mouse.move(point.x - 12, point.y, { steps: 3 });
    await active.locator('[data-library-drag-handle][aria-grabbed="true"]').waitFor({ state: "attached", timeout: 3_000 });
  } catch (error) {
    const evidence = await active.evaluate(({ x, y }) => {
      const traced = window as LibraryDragTraceWindow;
      const describe = (element: Element | null) => element?.outerHTML.slice(0, 160) ?? "nothing";
      return {
        trace: traced.__libraryDragTrace ?? [],
        underPressPoint: describe(document.elementFromPoint(x, y)),
        focused: document.hasFocus(),
        activeElement: describe(document.activeElement),
        drawers: [...document.querySelectorAll(".right-drawer")].map((drawer) => drawer.getAttribute("class")),
        grabbed: [...document.querySelectorAll("[aria-grabbed='true']")].map(describe),
      };
    }, point);
    await active.mouse.up();
    throw new Error(`Library drag did not start: ${JSON.stringify(evidence, null, 2)}\n${String(error)}`);
  } finally {
    await active.evaluate(() => (window as LibraryDragTraceWindow).__stopLibraryDragTrace?.());
  }
}

/** Carry an active library drag to `target`'s bottom edge and return its bottom drop indicator. */
async function moveLibraryDragToBottomEdge(active: Page, target: Locator): Promise<{ indicator: Locator; targetBox: { x: number; y: number; width: number; height: number } }> {
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("Library drag target geometry is unavailable.");
  const point = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height - 8 };
  await active.mouse.move(point.x, point.y, { steps: 12 });
  const indicator = target.locator(":scope > .composition-drop-indicator--bottom");
  try {
    await indicator.waitFor({ timeout: 5_000 });
  } catch (error) {
    const evidence = await target.evaluate((element, { x, y }) => {
      const describe = (node: Element | null) => node?.outerHTML.slice(0, 160) ?? "nothing";
      const under = document.elementFromPoint(x, y);
      return {
        underPointer: describe(under),
        pointerInsideTarget: under !== null && element.contains(under),
        targetRect: element.getBoundingClientRect().toJSON(),
        indicators: [...document.querySelectorAll(".composition-drop-indicator")].map(describe),
        grabbed: [...document.querySelectorAll("[aria-grabbed='true']")].map(describe),
      };
    }, point);
    await active.mouse.up();
    throw new Error(`Library drag found no drop indicator: ${JSON.stringify({ point, measured: targetBox, ...evidence }, null, 2)}\n${String(error)}`);
  }
  return { indicator, targetBox };
}

/** Submit the open "Add component" dialog with Enter on its focused submit button, or fail with evidence. */
async function submitAddComponentWithEnter(active: Page): Promise<void> {
  const dialog = active.getByRole("dialog", { name: "Add component" });
  const submit = dialog.getByRole("button", { name: "Add component", exact: true });
  await submit.focus();
  // EditorModal moves focus to its first field one frame after mounting; let that settle first.
  await active.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (!await submit.evaluate((element) => element === document.activeElement)) await submit.focus();
  await active.keyboard.press("Enter");
  try {
    await dialog.waitFor({ state: "detached", timeout: 5_000 });
  } catch (error) {
    const evidence = await active.evaluate(() => {
      const describe = (node: Element | null) => node?.outerHTML.slice(0, 160) ?? "nothing";
      const open = document.querySelector(".editor-modal__panel");
      return {
        dialogText: open instanceof HTMLElement ? open.innerText.slice(0, 600) : "no dialog",
        alerts: [...document.querySelectorAll("[role='alert']")].map((node) => (node as HTMLElement).innerText.slice(0, 200)),
        activeElement: describe(document.activeElement),
        focused: document.hasFocus(),
      };
    });
    throw new Error(`Add component stayed open after Enter: ${JSON.stringify(evidence, null, 2)}\n${String(error)}`);
  }
}

/** Wait for the agent composer's "Full prompt" to show `text`, or fail with the panel's own preview state. */
async function waitForFullAgentPrompt(composer: Locator, text: string): Promise<void> {
  try {
    await composer.getByLabel("Full agent prompt").getByText(text, { exact: false }).waitFor();
  } catch (error) {
    const evidence = await composer.evaluate((dialog) => ({
      previewError: dialog.querySelector(".agent-prompt__error")?.textContent ?? null,
      template: dialog.querySelector(".agent-prompt__template--selected")?.textContent ?? null,
      values: [...dialog.querySelectorAll(".agent-prompt__var")].map((field) => ({
        name: field.querySelector("span")?.textContent ?? "",
        value: field.querySelector<HTMLInputElement>("input")?.value ?? "",
      })),
      fullPrompt: dialog.querySelector("[aria-label='Full agent prompt']")?.textContent ?? null,
    }));
    throw new Error(`Full agent prompt never showed ${JSON.stringify(text)}: ${JSON.stringify(evidence, null, 2)}\n${String(error)}`);
  }
}

async function persistedGroupCount(active: Page = currentPage()): Promise<number> {
  return await active.evaluate(async () => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__;
    if (!host) throw new Error("UI harness host is unavailable.");
    const config = await host.getSnapshot().then((snapshot) => snapshot.config);
    const visit = (node: ComponentNode): number => {
      const visitLayout = (layout: ComponentChildLayout): number =>
        "node" in layout ? visit(layout.node) : visitLayout(layout.first) + visitLayout(layout.second);
      const children = node.children;
      const nested = children === undefined ? 0 : Array.isArray(children)
        ? children.reduce((sum, edge) => sum + visit(edge.node), 0)
        : visitLayout(children);
      return (node.component === "./components/external/core/group" && node.id !== "group" ? 1 : 0) + nested;
    };
    return config ? visit(config.root) : 0;
  });
}

async function persistedTodoDone(active: Page = currentPage()): Promise<boolean | undefined> {
  return await active.evaluate(async () => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__;
    if (!host) throw new Error("UI harness host is unavailable.");
    const root = (await host.getSnapshot()).config?.root;
    const visit = (node: ComponentNode): boolean | undefined => {
      if (node.id === "renderer-proof-todos") return (node.props?.todos as Array<{ done?: boolean }> | undefined)?.[0]?.done;
      const visitLayout = (layout: ComponentChildLayout): boolean | undefined =>
        "node" in layout ? visit(layout.node) : visitLayout(layout.first) ?? visitLayout(layout.second);
      const children = node.children;
      if (children === undefined) return undefined;
      if (!Array.isArray(children)) return visitLayout(children);
      for (const edge of children) {
        const found = visit(edge.node);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return root ? visit(root) : undefined;
  });
}

async function persistedResponsiveSiblingOrder(active: Page = currentPage()): Promise<string[]> {
  return await active.evaluate(async () => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__;
    if (!host) throw new Error("UI harness host is unavailable.");
    const config = await host.getSnapshot().then((snapshot) => snapshot.config);
    const find = (node: ComponentNode, id: string): ComponentNode | null => {
      if (node.id === id) return node;
      const visitLayout = (layout: ComponentChildLayout): ComponentNode | null =>
        "node" in layout ? find(layout.node, id) : visitLayout(layout.first) ?? visitLayout(layout.second);
      const children = node.children;
      if (children === undefined) return null;
      if (!Array.isArray(children)) return visitLayout(children);
      for (const edge of children) {
        const found = find(edge.node, id);
        if (found) return found;
      }
      return null;
    };
    const group = config ? find(config.root, "group") : null;
    const layout = group?.children;
    const leaves = (current: ComponentChildLayout): string[] => "node" in current
      ? [current.node.id ?? current.node.component]
      : [...leaves(current.first), ...leaves(current.second)];
    return layout && !Array.isArray(layout) ? leaves(layout) : [];
  });
}

beforeAll(async () => {
  const executablePath = process.env.DASH_BORED_BROWSER_EXECUTABLE
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(executablePath);
  const port = await unusedPort();
  fixtureUrl = `http://127.0.0.1:${port}/ui-harness.html`;
  fixtureServer = startFixtureServer({
    cmd: ["bun", "./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    cwd: process.cwd(),
    env: { ...process.env, DASH_BORED_VITE_PORT: String(port) },
    url: fixtureUrl,
  });
  await fixtureServer.ready;
  browser = await chromium.launch({ executablePath, headless: true });
  page = await openPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Open component library" }).waitFor();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await fixtureServer?.stop();
}, 30_000);

describe("renderer fixture interactions", () => {
  test("Bring app to front reaches the native host without discarding a dashboard draft", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      await proof.evaluate(() => {
        window.__DASH_BORED_UI_HARNESS_HOST__!.focusWindow = async () => {
          document.body.dataset.windowFocusRequests = "1";
        };
      });
      const saved = await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig());
      await addGroupDraft(proof);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("bring app to front");
      await palette.getByRole("option", { name: /Bring app to front/ }).click();
      await proof.waitForFunction(() => document.body.dataset.windowFocusRequests === "1");
      expect(await proof.getByRole("region", { name: "Dashboard editor" }).count()).toBe(1);
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig())).toEqual(saved);
      expect(await persistedGroupCount(proof)).toBe(0);
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("package recovery keeps configuration visible to the host and wires Retry and Sync", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const saved = await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig());
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const original = host.manageExternalComponent.bind(host);
        host.manageExternalComponent = async (operation) => {
          const result = await original(operation);
          if (operation.op === "restore") throw new Error("Remote remains offline; pins are preserved.");
          await host.setDiagnostics([]);
          return result;
        };
        await host.setDiagnostics([{ severity: "error", code: "PACKAGE_RESTORE_FAILED", message: "Could not restore core: remote offline.", file: "/ui-harness/.dash-bored/dash-bored-lock.yaml" }]);
      });
      const recovery = proof.getByRole("region", { name: "Package recovery", exact: true });
      await recovery.waitFor();
      await proof.getByText("Could not restore core: remote offline.", { exact: true }).waitFor();
      await recovery.getByRole("button", { name: "Retry package restoration", exact: true }).click();
      await proof.getByText("Remote remains offline; pins are preserved.", { exact: true }).waitFor();
      expect(await recovery.isVisible()).toBe(true);
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig())).toEqual(saved);
      await recovery.getByRole("button", { name: "Sync pinned packages", exact: true }).click();
      await recovery.waitFor({ state: "detached" });
      const operations = await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPackageOperations());
      expect(operations).toEqual([{ kind: "external", op: "restore" }, { kind: "external", op: "sync" }]);
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig())).toEqual(saved);
    } finally { await proof.close(); }
  }, 20_000);

  test("all 17 pinned core outputs export ordinary components through the actual compiler", async () => {
    const proof = await openPage();
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const payload = JSON.parse(await readFile(".cottontail-tmp/core-fixture.json", "utf8"));
      const exports = await proof.evaluate(async (components: {componentId:string;javascript:string}[]) => {
        const results: string[] = [];
        for (const component of components) {
          const url = URL.createObjectURL(new Blob([component.javascript], {type:"text/javascript"}));
          try { const module = await import(url); if(typeof module.default !== "function") throw new Error(`${component.componentId} has no default renderer`); results.push(component.componentId); }
          finally { URL.revokeObjectURL(url); }
        }
        return results;
      }, payload.components);
      expect(exports.length).toBe(17);
      expect(exports.every(id => id.startsWith("core/"))).toBe(true);
    } finally { await proof.close(); }
  }, 20_000);

  test("component cards show their manifest summary", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    try {
      const conditional = active.locator(".right-drawer li").filter({ hasText: "./components/external/core/conditional" });
      await conditional.getByText(/Recovery visibility for one tiled child/).waitFor();
      const summary = await conditional.innerText();
      expect(summary).toContain("Sizing: organizational layout");
      expect(summary).toContain("Children: minimum 1, maximum 1; tiled horizontally or vertically");
      expect(summary).toContain("Permissions: Run project commands");
    } finally {
      await active.getByRole("button", { name: "Close Component library", exact: true }).click();
    }
  });

  test("right drawer keeps normal Tab navigation instead of trapping focus", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    const drawer = active.getByRole("dialog", { name: "Component library" });
    const search = drawer.getByRole("searchbox", { name: "Search components" });
    await search.waitFor();
    await active.waitForFunction(() => document.activeElement === document.querySelector(".right-drawer input[type=search]"));

    // Start at the drawer's first tab stop. Shift+Tab must follow document
    // order back into the app shell, leaving the non-modal drawer open.
    await drawer.getByRole("button", { name: "Add", exact: true }).focus();
    await active.keyboard.press("Shift+Tab");
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    expect(await drawer.count()).toBe(1);

    await drawer.getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("opening and cleanly closing the library does not begin a draft", async () => {
    const active = currentPage();
    expect(await persistedGroupCount()).toBe(0);
    await active.getByRole("button", { name: "Open component library" }).click();
    expect(await active.locator(".composition-frame-controls").count()).toBe(0);
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await active.getByRole("button", { name: "Save dashboard" }).count()).toBe(0);
    expect(await persistedGroupCount()).toBe(0);
  }, 20_000);

  test("mounting nested frames leaves global pointer gesture listeners idle", async () => {
    const active = currentPage();
    await active.addInitScript(() => {
      const original = window.addEventListener;
      const observed: string[] = [];
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (["pointermove", "pointerup", "mouseup"].includes(type)) observed.push(type);
        return original.call(window, type, listener, options);
      }) as typeof window.addEventListener;
      (window as Window & { __pointerSessionListeners?: string[] }).__pointerSessionListeners = observed;
    });
    await active.reload();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
    await active.locator("[data-node-id]").nth(1).waitFor();
    expect(await active.locator("[data-node-id]").count()).toBeGreaterThan(1);
    expect(await active.evaluate(() => (
      (window as Window & { __pointerSessionListeners?: string[] }).__pointerSessionListeners ?? []
    ))).toEqual([]);
  }, 20_000);

  test("shell controls expand navigation and open the command palette", async () => {
    const active = currentPage();
    const shell = active.locator(".app-shell");
    const sidebarToggle = active.getByRole("button", { name: "Expand sidebar" });

    expect(await shell.getAttribute("class")).not.toContain("app-shell--sidebar-expanded");
    await sidebarToggle.click();
    await active.getByRole("button", { name: "Collapse sidebar" }).waitFor();
    expect(await shell.getAttribute("class")).toContain("app-shell--sidebar-expanded");

    await active.getByRole("button", { name: /Open command palette/ }).click();
    const palette = active.getByRole("dialog", { name: "Command palette" });
    await palette.waitFor();
    expect(await palette.getByRole("combobox").count()).toBe(1);
    await palette.getByRole("combobox").fill("reload app");
    await palette.getByRole("option", { name: /Reload app/ }).waitFor();
    await palette.getByRole("combobox").fill("app reload");
    expect(await palette.getByRole("option").first().innerText()).toContain("Reload app");

    await active.keyboard.press("Escape");
    expect(await palette.count()).toBe(0);

    await active.getByRole("button", { name: "Collapse sidebar" }).click();
    await active.getByRole("button", { name: "Expand sidebar" }).waitFor();
    expect(await shell.getAttribute("class")).not.toContain("app-shell--sidebar-expanded");
  }, 20_000);

  test("repeating the same app-control palette query resets edited search text", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.waitForFunction(() => window.__DASH_BORED_UI_HARNESS_RUN_ACTION__ !== undefined);
      const openPalette = async (query: string) => proof.evaluate(async (value) => {
        const run = window.__DASH_BORED_UI_HARNESS_RUN_ACTION__;
        if (!run) throw new Error("Renderer app-control action handler is unavailable.");
        return run({ reference: "app:open-palette", args: { query: value } });
      }, query);
      await openPalette("todo status");
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      await palette.waitFor();
      await proof.waitForFunction((query) => document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value === query, "todo status");
      expect(await input.inputValue()).toBe("todo status");
      await input.fill("Edited by the user");
      await openPalette("todo status");
      await proof.waitForFunction((query) => document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value === query, "todo status");
      expect(await input.inputValue()).toBe("todo status");
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("palette search keeps the top result selected until the pointer moves", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      const options = palette.getByRole("option");
      const secondBox = await options.nth(1).boundingBox();
      if (!secondBox) throw new Error("Second palette result is unavailable.");
      const pointer = { x: secondBox.x + 20, y: secondBox.y + secondBox.height / 2 };
      await proof.mouse.move(pointer.x, pointer.y);
      expect(await options.nth(1).getAttribute("aria-selected")).toBe("true");

      await input.press("Escape");
      await proof.keyboard.press("Meta+k");
      await palette.waitFor();
      const settlePointer = () => proof.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await settlePointer();
      expect(await options.first().getAttribute("aria-selected")).toBe("true");

      for (const character of "app") {
        await input.press(character);
        await settlePointer();
        expect(await options.first().getAttribute("aria-selected")).toBe("true");
        expect(await input.getAttribute("aria-activedescendant")).toBe(await options.first().getAttribute("id"));
      }
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);

      // Moving inside the already-hovered row must resume pointer selection.
      await proof.mouse.move(pointer.x + 1, pointer.y);
      const hoveredId = await proof.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[role="option"]')?.id, pointer);
      if (!hoveredId) throw new Error("The stationary cursor no longer covers a palette result.");
      expect(await proof.locator(`#${hoveredId}`).getAttribute("aria-selected")).toBe("true");
      expect(await input.getAttribute("aria-activedescendant")).toBe(hoveredId);

      await input.press("ArrowDown");
      const keyboardSelection = await input.getAttribute("aria-activedescendant");
      await settlePointer();
      expect(await input.getAttribute("aria-activedescendant")).toBe(keyboardSelection);
      await input.press("Backspace");
      await settlePointer();
      expect(await options.first().getAttribute("aria-selected")).toBe("true");
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("focus targets are choices under one main palette action", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("focus");
      await palette.getByRole("option", { name: /Focus component/ }).waitFor();
      expect(await palette.getByRole("option", { name: /Focus component/ }).count()).toBe(1);
      expect(await palette.getByRole("option", { name: /Bring app to front/ }).count()).toBe(1);
      await palette.getByRole("option", { name: /Focus component/ }).click();
      await palette.getByRole("listbox", { name: "Focus component", exact: true }).waitFor();
      // The chooser reuses the one search input, labelled for its step.
      expect(await palette.getByRole("combobox").count()).toBe(1);
      const optionSearch = palette.getByRole("combobox", { name: "Search focus component options" });
      await optionSearch.fill("responsive tile");
      const matches = palette.getByRole("option");
      expect(await matches.count()).toBeGreaterThan(0);
      expect(await matches.first().getAttribute("aria-selected")).toBe("true");
      await palette.getByRole("button", { name: "Back: Focus component", exact: true }).click();
      const actionSearch = palette.getByRole("combobox", { name: "Search actions and commands" });
      await actionSearch.waitFor();
      expect(await actionSearch.inputValue()).toBe("focus");
      await palette.getByRole("option", { name: /Focus component/ }).click();
      await optionSearch.fill("responsive tile");
      await palette.getByRole("option", { name: /^Responsive tile/ }).click();
      await palette.waitFor({ state: "hidden" });
      const path = proof.getByRole("navigation", { name: "Focused component path" });
      await path.waitFor();
      expect(await path.innerText()).toContain("Responsive tile");
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("palette search reaches a chooser option directly by node ID", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const actionSearch = palette.getByRole("combobox");
      await actionSearch.fill("renderer-proof-todos");
      const target = palette.getByRole("option", { name: /^Focus component\W+YAML todo list/ });
      await target.waitFor();
      expect(await palette.getByRole("option").first().getAttribute("id")).toBe(await target.getAttribute("id"));
      expect(await actionSearch.getAttribute("aria-activedescendant")).toBe(await target.getAttribute("id"));
      await actionSearch.press("Enter");
      await palette.waitFor({ state: "hidden" });
      await proof.getByRole("navigation", { name: "Focused component path" }).getByText("YAML todo list", { exact: true }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("recent palette runs lead the results, follow the search, and replay their options", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      const options = palette.getByRole("option");
      const headings = palette.locator(".command-palette__group");
      const focusedPath = proof.getByRole("navigation", { name: "Focused component path" });
      const open = async () => {
        await proof.getByRole("button", { name: /Open command palette/ }).click();
        await palette.waitFor();
      };
      const runSearch = async (query: string) => {
        await input.fill(query);
        await input.press("Enter");
        await palette.waitFor({ state: "hidden" });
      };

      await open();
      expect(await headings.first().textContent()).not.toBe("Recent");
      await runSearch("renderer-proof-todos");
      await focusedPath.getByText("YAML todo list", { exact: true }).waitFor();
      await open();
      await runSearch("show whole dashboard");
      await focusedPath.waitFor({ state: "hidden" });

      await open();
      expect(await headings.first().textContent()).toBe("Recent");
      expect(await options.nth(0).innerText()).toContain("Show whole dashboard");
      expect(await options.nth(1).innerText()).toMatch(/^Focus component\W+YAML todo list/);
      // A recent run is listed once, in Recent, rather than again in its group.
      expect(await palette.getByRole("option", { name: /^Show whole dashboard/ }).count()).toBe(1);

      await input.fill("yaml todo");
      expect(await headings.first().textContent()).toBe("Recent");
      expect(await options.first().innerText()).toMatch(/^Focus component\W+YAML todo list/);
      expect(await palette.getByRole("option", { name: /^Focus component\W+YAML todo list/ }).count()).toBe(1);
      expect(await options.first().getAttribute("aria-selected")).toBe("true");
      await input.press("Meta+Enter");
      await focusedPath.getByText("YAML todo list", { exact: true }).waitFor();
      // Kept open with a cleared search; the replayed target is focused now, so like its option row it waits.
      expect(await input.inputValue()).toBe("");
      expect(await options.first().innerText()).toContain("Show whole dashboard");
      expect(await palette.getByRole("option", { name: /^Focus component\W+YAML todo list/ }).count()).toBe(0);
      await input.press("Meta+Enter");
      await focusedPath.waitFor({ state: "hidden" });
      expect(await options.nth(1).innerText()).toMatch(/^Focus component\W+YAML todo list/);

      await input.fill("sidebar");
      // Without matching recent runs, search results keep their plain relevance list.
      expect(await headings.count()).toBe(0);
      await input.press("Meta+Enter");
      expect(await options.first().innerText()).toMatch(/sidebar/i);
      expect(await options.first().getAttribute("aria-selected")).toBe("true");
      await input.press("Escape");
      await palette.waitFor({ state: "hidden" });

      await proof.reload();
      await open();
      // The history survives a reload, most recent first.
      expect(await options.nth(0).innerText()).toMatch(/sidebar/i);
      expect(await options.nth(1).innerText()).toContain("Show whole dashboard");
      expect(await options.nth(2).innerText()).toMatch(/^Focus component\W+YAML todo list/);
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("reveal targets are choices under one main palette action", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      const frame = proof.locator('[data-node-id="responsive-card"]');
      await frame.waitFor();
      await frame.locator("header").first().click({ button: "right" });
      await proof.getByRole("menuitem", { name: "Collapse component", exact: true }).click();
      await frame.getByRole("button", { name: "Expand Responsive tile component", exact: true }).waitFor();
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("reveal");
      await palette.getByRole("option", { name: /Reveal component/ }).waitFor();
      expect(await palette.getByRole("option", { name: /^Reveal / }).count()).toBe(1);
      await palette.getByRole("option", { name: /Reveal component/ }).click();
      await palette.getByRole("listbox", { name: "Reveal component", exact: true }).waitFor();
      // Backspace in an empty chooser steps back like Escape and the breadcrumb.
      await palette.getByRole("combobox").press("Backspace");
      await palette.getByRole("listbox", { name: "Available commands", exact: true }).waitFor();
      await palette.getByRole("option", { name: /Reveal component/ }).click();
      await palette.getByRole("combobox").fill("responsive-card");
      const target = palette.getByRole("option", { name: /^Responsive tile/ });
      expect(await target.count()).toBe(1);
      expect(await target.getAttribute("aria-selected")).toBe("true");
      await target.click();
      await palette.waitFor({ state: "hidden" });
      await frame.locator(".component-node__collapsed").waitFor({ state: "hidden" });
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("Command execution keeps the palette open and clears search by default for repeated actions", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      await input.fill("expand sidebar");
      await input.press("Meta+Enter");
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
      expect(await input.evaluate((element) => element === document.activeElement)).toBeTrue();
      await input.fill("collapse sidebar");
      await palette.getByRole("option", { name: /Collapse sidebar/ }).click({ modifiers: ["Meta"] });
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
      await input.fill("reveal");
      await input.press("Meta+Enter");
      await palette.getByRole("listbox", { name: "Reveal component", exact: true }).waitFor();
      await palette.getByRole("option", { name: /^Responsive tile/ }).click();
      await palette.getByRole("listbox", { name: "Available commands", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
      // Holding Command at the final choice works even when the parent opened normally.
      await input.fill("reveal");
      // The reveal that just ran leads as a recent run; its chooser follows.
      expect(await palette.getByRole("option").first().innerText()).toMatch(/^Reveal component\W+Responsive tile/);
      await input.press("ArrowDown");
      await input.press("Enter");
      await palette.getByRole("listbox", { name: "Reveal component", exact: true }).waitFor();
      await input.fill("Responsive tile");
      await input.press("Meta+Enter");
      await palette.getByRole("listbox", { name: "Available commands", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
      await input.fill("expand sidebar");
      await input.press("Enter");
      await palette.waitFor({ state: "hidden" });
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("General setting preserves search for keep-open execution and persists through reopening Settings", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Settings", exact: true }).click();
      const preference = proof.getByRole("checkbox", { name: "Clear search when keeping the palette open" });
      expect(await preference.isChecked()).toBeTrue();
      await proof.screenshot({ path: "/tmp/dash-bored-palette-settings-desktop.png" });
      await proof.setViewportSize({ width: 390, height: 844 });
      await proof.screenshot({ path: "/tmp/dash-bored-palette-settings-narrow.png" });
      const cardBox = await proof.locator('[aria-labelledby="palette-settings-title"]').boundingBox();
      if (!cardBox) throw new Error("Palette settings are not visible.");
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390);
      await preference.uncheck();
      await proof.getByRole("status").getByText("Keep-open actions will preserve the palette search.", { exact: true }).waitFor();
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      await input.fill("show dashboard");
      await input.press("Meta+Enter");
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("show dashboard");
      await proof.screenshot({ path: "/tmp/dash-bored-palette-keep-open-narrow.png" });
      // Availability refreshes after execution; a disabled action cannot close or clear the palette.
      expect(await palette.getByRole("option", { name: /Show dashboard/ }).getAttribute("aria-disabled")).toBe("true");
      await input.press("Meta+Enter");
      expect(await input.inputValue()).toBe("show dashboard");
      // A kept-open run that moves its row into Recent keeps that row selected.
      await input.fill("dashboard");
      const rows = await palette.getByRole("option").allInnerTexts();
      const sidebarRow = rows.findIndex((text) => text.startsWith("Expand sidebar"));
      expect(sidebarRow).toBeGreaterThan(1);
      for (let step = 0; step < sidebarRow; step += 1) await input.press("ArrowDown");
      await input.press("Meta+Enter");
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      expect(await input.inputValue()).toBe("dashboard");
      // Recent orders by relevance while searching: the label match leads the description match.
      const recentRows = (await palette.getByRole("option").allInnerTexts()).slice(0, 2);
      expect(recentRows.map((text) => text.split("\n")[0])).toEqual(["Show dashboard", "Collapse sidebar"]);
      await palette.getByRole("option").nth(1).and(palette.locator('[aria-selected="true"]')).waitFor();
      await input.press("Meta+Enter");
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      await proof.keyboard.press("Escape");
      await proof.getByRole("button", { name: "Settings", exact: true }).click();
      expect(await preference.isChecked()).toBeFalse();
      await preference.check();
      await proof.getByRole("status").getByText("Keep-open actions will clear the palette search.", { exact: true }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("keep-open intent crosses confirmation and multiple choice steps without bypassing them", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      await input.fill("set default theme");
      await input.press("Meta+Enter");
      await palette.getByRole("listbox", { name: "Select default theme", exact: true }).waitFor();
      await palette.getByRole("listbox", { name: "Select default theme", exact: true }).getByRole("option").first().click();
      await palette.getByRole("listbox", { name: "Select default appearance", exact: true }).waitFor();
      await palette.getByRole("option", { name: "Light", exact: true }).click();
      await input.waitFor();
      expect(await input.inputValue()).toBe("");
      await proof.waitForFunction(() => document.documentElement.dataset.appearance === "light");
      await input.fill("revoke project trust");
      await input.press("Meta+Enter");
      await palette.getByRole("heading", { name: "Revoke project trust?", exact: true }).waitFor();
      expect(await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).trusted)).toBeTrue();
      await palette.getByRole("button", { name: "Revoke trust", exact: true }).click();
      await input.waitFor();
      await proof.waitForFunction(async () => !(await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).trusted);
      expect(await input.inputValue()).toBe("");
      await proof.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("active dashboard clicks and Command numbers toggle the sidebar while Settings returns to the dashboard", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      const activeDashboard = proof.locator(".sidebar__project-link[aria-current=page]");
      await activeDashboard.waitFor();
      await activeDashboard.click();
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      await proof.keyboard.press("Meta+1");
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      await proof.keyboard.press("Meta+1");
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      await activeDashboard.click();
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      await proof.getByRole("button", { name: "Settings", exact: true }).click();
      await proof.keyboard.press("Meta+1");
      await activeDashboard.waitFor();
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      expect(await proof.getByRole("button", { name: "Open component library", exact: true }).count()).toBe(1);
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("default action shortcuts run actions and appear in the palette", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      await proof.keyboard.press("Meta+B");
      await proof.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      await proof.keyboard.press("Meta+B");
      await proof.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();

      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("open settings");
      expect(await palette.getByRole("option", { name: /Open settings/ }).locator("kbd").innerText()).toBe("⌘,");
      await proof.keyboard.press("Escape");

      await proof.keyboard.press("Meta+,");
      await proof.getByRole("main", { name: "Settings" }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("Command numbers follow draggable sidebar order and yield to the palette", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.addInitScript(() => {
        let host: typeof window.__DASH_BORED_UI_HARNESS_HOST__;
        Object.defineProperty(window, "__DASH_BORED_UI_HARNESS_HOST__", {
          configurable: true,
          get: () => host,
          set: (value: NonNullable<typeof host>) => {
            host = value;
            let projects: Awaited<ReturnType<typeof value.listProjects>> = [];
            const originalList = value.listProjects.bind(value);
            value.listProjects = async () => {
              if (!projects.length) {
                const first = (await originalList())[0]!;
                projects = [first, ...Array.from({ length: 9 }, (_, index) => ({
                  ...first, configPath: `/fixture/dashboard-${index + 2}.yaml`, dashboardName: `Dashboard ${index + 2}`,
                }))];
              }
              return structuredClone(projects);
            };
            value.moveProject = async (source, target, before) => {
              const item = projects.find((project) => project.configPath === source)!;
              projects = projects.filter((project) => project !== item);
              projects.splice(projects.findIndex((project) => project.configPath === target) + (before ? 0 : 1), 0, item);
              return structuredClone(projects);
            };
            const originalOpen = value.openProject.bind(value);
            value.openProject = async (project) => {
              document.documentElement.dataset.openedDashboard = project.configPath;
              return originalOpen(project);
            };
          },
        });
      });
      await proof.goto(fixtureUrl);
      const rows = proof.locator(".sidebar__project-link");
      await proof.getByRole("button", { name: "Dashboard 10", exact: true }).waitFor();
      await proof.keyboard.down("Meta");
      expect(await proof.locator(".sidebar__shortcut-number").allTextContents()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
      await proof.screenshot({ path: "/tmp/dash-bored-sidebar-number-hints.png" });
      await proof.keyboard.press("9");
      await proof.waitForFunction(() => document.documentElement.dataset.openedDashboard === "/fixture/dashboard-9.yaml");
      await proof.keyboard.up("Meta");
      expect(await proof.locator(".sidebar__shortcut-number").count()).toBe(0);
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      await proof.keyboard.down("Meta");
      expect(await proof.locator(".sidebar__shortcut-number").count()).toBe(0);
      await proof.keyboard.press("2");
      expect(await proof.evaluate(() => document.documentElement.dataset.openedDashboard)).toBe("/fixture/dashboard-9.yaml");
      await proof.keyboard.up("Meta");
      await proof.keyboard.press("Escape");
      await proof.getByRole("button", { name: "Dashboard 3", exact: true }).dragTo(rows.first(), { targetPosition: { x: 15, y: 5 } });
      await proof.waitForFunction(() => document.querySelector(".sidebar__project-link")?.getAttribute("aria-label") === "Dashboard 3");
      await proof.keyboard.press("Meta+1");
      await proof.waitForFunction(() => document.documentElement.dataset.openedDashboard === "/fixture/dashboard-3.yaml");
      await proof.keyboard.down("Meta");
      await proof.evaluate(() => window.dispatchEvent(new Event("blur")));
      expect(await proof.locator(".sidebar__shortcut-number").count()).toBe(0);
      await proof.keyboard.up("Meta");
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("Switch dashboard opens its chooser and supports keep-open navigation", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Settings", exact: true }).click();
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      const input = palette.getByRole("combobox");
      await input.fill("switch dashboard");
      await palette.getByRole("option", { name: /Switch dashboard/ }).click();
      const choices = palette.getByRole("listbox", { name: "Switch dashboard", exact: true });
      await choices.waitFor();
      expect(await choices.getByRole("option").count()).toBe(1);
      await input.press("Meta+Enter");
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      await input.waitFor();
      expect(await input.inputValue()).toBe("");
      await proof.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("brand decoration stays centered inside the icon throughout sidebar transitions", async () => {
    const active = currentPage();
    const originalViewport = active.viewportSize();
    const sampleTransition = () => active.evaluate(async () => {
      const mark = document.querySelector(".sidebar__toggle .brand-mark")!;
      const dots = document.querySelector(".brand-mark__dots")!;
      const toggle = document.querySelector(".sidebar__toggle")!;
      const samples: Array<{ x: number; y: number; visible: boolean; contained: boolean; centeredX: number; centeredY: number }> = [];
      const started = performance.now();
      do {
        const icon = mark.getBoundingClientRect();
        const decoration = dots.getBoundingClientRect();
        const clip = toggle.getBoundingClientRect();
        const border = getComputedStyle(toggle);
        samples.push({
          x: decoration.x - icon.x,
          y: decoration.y - icon.y,
          contained: decoration.left > icon.left && decoration.right < icon.right
            && decoration.top > icon.top && decoration.bottom < icon.bottom,
          centeredX: decoration.left + decoration.width / 2 - (icon.left + icon.width / 2),
          centeredY: decoration.top + decoration.height / 2 - (icon.top + icon.height / 2),
          visible: decoration.left >= clip.left + parseFloat(border.borderLeftWidth)
            && decoration.right <= clip.right - parseFloat(border.borderRightWidth)
            && decoration.top >= clip.top + parseFloat(border.borderTopWidth)
            && decoration.bottom <= clip.bottom - parseFloat(border.borderBottomWidth),
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() - started < 300);
      return samples;
    });
    try {
      for (const width of [1280, 390]) {
        await active.setViewportSize({ width, height: 844 });
        const [baseline] = await sampleTransition();
        expect(baseline).toMatchObject({ visible: true, contained: true });
        for (const label of ["Expand sidebar", "Collapse sidebar"]) {
          await active.getByRole("button", { name: label, exact: true }).click();
          for (const sample of await sampleTransition()) {
            expect(sample.x).toBeCloseTo(baseline!.x, 4);
            expect(sample.y).toBeCloseTo(baseline!.y, 4);
            expect(sample).toMatchObject({ visible: true, contained: true });
            expect(sample.centeredX).toBeCloseTo(0, 4);
            expect(sample.centeredY).toBeCloseTo(0, 4);
          }
        }
        await active.getByRole("button", { name: "Expand sidebar", exact: true }).hover();
        expect((await sampleTransition()).every((sample) => sample.visible)).toBe(true);
      }
    } finally {
      if (originalViewport) await active.setViewportSize(originalViewport);
    }
  }, 20_000);

  test("palette choice steps reuse the search row and full-width result rows", async () => {
    const active = currentPage();
    const originalViewport = active.viewportSize();
    for (const width of [1280, 390]) {
      await active.setViewportSize({ width, height: 844 });
      await active.getByRole("button", { name: /Open command palette/ }).click();
      const palette = active.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Set default theme");
      await palette.getByRole("option", { name: /Set default theme/ }).click();
      const crumb = palette.getByRole("button", { name: "Back: Set default theme", exact: true });
      await crumb.waitFor();
      const group = palette.getByRole("listbox", { name: "Select default theme" });
      const search = palette.getByRole("combobox");
      expect(await search.getAttribute("placeholder")).toBe("Select default theme…");
      const bounds = await palette.boundingBox();
      const crumbBox = await crumb.boundingBox();
      const searchBox = await search.boundingBox();
      const list = await group.boundingBox();
      const option = await group.getByRole("option").first().boundingBox();
      expect(bounds && crumbBox && searchBox && list && option).toBeTruthy();
      expect(crumbBox!.x + crumbBox!.width).toBeLessThanOrEqual(searchBox!.x);
      expect(list!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height);
      const listPadding = await group.evaluate((element) => {
        const styles = getComputedStyle(element);
        return Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      });
      expect(Math.abs(option!.width - (list!.width - listPadding))).toBeLessThan(1);
      expect(await palette.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      // The chooser keeps the search input focused and moves its active descendant.
      const options = group.getByRole("option");
      const isFocused = () => search.evaluate(
        (element) => element === document.activeElement,
      );
      const activeOption = () => search.getAttribute("aria-activedescendant");
      expect(await isFocused()).toBe(true);
      expect(await activeOption()).toBe(await options.nth(0).getAttribute("id"));
      await active.keyboard.press("ArrowDown");
      expect(await isFocused()).toBe(true);
      expect(await activeOption()).toBe(await options.nth(1).getAttribute("id"));
      await active.keyboard.press("ArrowUp");
      expect(await activeOption()).toBe(await options.nth(0).getAttribute("id"));
      await active.keyboard.press("ArrowUp");
      const lastOption = options.nth(await options.count() - 1);
      expect(await activeOption()).toBe(await lastOption.getAttribute("id"));
      await active.keyboard.press("ArrowDown");
      expect(await activeOption()).toBe(await options.nth(0).getAttribute("id"));
      await active.keyboard.press("ArrowDown");
      const chosen = await options.nth(1).locator("strong").innerText();
      await active.keyboard.press("Enter");
      await palette.getByRole("listbox", { name: "Select default appearance" }).waitFor();
      await palette.getByRole("button", { name: `Back: Set default theme › ${chosen}`, exact: true }).waitFor();
      await active.keyboard.press("Escape");
      await group.waitFor();
      await active.keyboard.press("Escape");
      await palette.getByRole("listbox", { name: "Available commands" }).waitFor();
      expect(await search.inputValue()).toBe("Set default theme");
      await active.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
    }
    if (originalViewport) await active.setViewportSize(originalViewport);
  });

  test("screenshot settings explain recovery after a reset and refresh the granted state", async () => {
    const proof = await openPage();
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Settings", exact: true }).click();
      const card = proof.getByRole("region", { name: "Agent screenshots" });
      await card.getByText("Screen Recording is not allowed for this build.", { exact: true }).waitFor();
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getScreenCaptureCommands().every((command) => command === "status"))).toBeTrue();
      // The inert fixture simulates the host's successful, user-confirmed reset.
      await card.getByRole("button", { name: "Reset Screen Recording permission", exact: true }).click();
      await card.getByText(/Permission reset. Quit and reopen dash-bored/).waitFor();
      await card.getByRole("button", { name: "Request access", exact: true }).click();
      await card.getByText("Screen Recording is allowed.", { exact: true }).waitFor();
      expect(await card.getByRole("button", { name: "Request access", exact: true }).isDisabled()).toBeTrue();
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getScreenCaptureCommands().filter((command) => command !== "status"))).toEqual(["repair", "request"]);
      await proof.screenshot({ path: "/tmp/dash-bored-screen-capture-settings.png", fullPage: true });
    } finally { await proof.close(); }
  });

  test("settings tabs manage action favorites and shortcuts reflected in the palette", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = active.getByRole("main", { name: "Settings" });
    await settings.getByRole("tab", { name: "General" }).waitFor();
    expect(await settings.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");

    const sidebarPreference = settings.getByRole("checkbox", { name: "Start expanded" });
    expect(await sidebarPreference.isChecked()).toBeFalse();
    await sidebarPreference.check();
    await active.getByRole("status").getByText("Sidebar will start expanded.", { exact: true }).waitFor();
    expect(await sidebarPreference.isChecked()).toBeTrue();
    expect(await active.locator(".app-shell").getAttribute("class")).toContain("app-shell--sidebar-expanded");
    await sidebarPreference.uncheck();
    await active.getByRole("status").getByText("Sidebar will start collapsed.", { exact: true }).waitFor();
    expect(await sidebarPreference.isChecked()).toBeFalse();
    expect(await active.locator(".app-shell").getAttribute("class")).not.toContain("app-shell--sidebar-expanded");

    await settings.getByRole("tab", { name: "Actions" }).click();
    expect(await settings.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    await settings.getByRole("searchbox", { name: "Search actions" }).fill("reload app");
    const favorite = settings.getByRole("button", { name: "Add Reload app to favorites" });
    await favorite.click();
    await settings.getByRole("button", { name: "Remove Reload app from favorites" }).waitFor();

    const shortcut = settings.getByRole("button", { name: /Reload app shortcut:/ });
    await shortcut.click();
    await active.keyboard.press("Meta+Alt+R");
    await settings.getByRole("button", { name: /Reload app shortcut:.*R/ }).waitFor();

    await active.getByRole("button", { name: /Open command palette/ }).click();
    const palette = active.getByRole("dialog", { name: "Command palette" });
    expect(await palette.getByText("Favorites", { exact: true }).count()).toBe(1);
    await palette.getByRole("combobox").fill("reload app");
    // Search results are ordered by relevance without group headings; favorites still lead.
    expect(await palette.getByText("Favorites", { exact: true }).count()).toBe(0);
    expect(await palette.getByRole("option").first().innerText()).toContain("Reload app");
    const reloadOption = palette.getByRole("option", { name: /Reload app/ });
    expect(await reloadOption.locator("kbd").count()).toBe(1);
    await palette.getByRole("button", { name: "Remove Reload app from favorites" }).click();
    await palette.getByRole("button", { name: "Add Reload app to favorites" }).waitFor();
    await active.keyboard.press("Escape");

    await shortcut.click();
    await active.keyboard.press("Meta+Shift+R");
    await settings.getByRole("button", { name: /Reload app shortcut:/ }).waitFor();
    await settings.getByRole("searchbox", { name: "Search actions" }).fill("show dashboard");
    const showDashboardShortcut = settings.getByRole("button", { name: /Show dashboard shortcut:/ });
    await showDashboardShortcut.click();
    await active.keyboard.press("Meta+Shift+D");
    await settings.getByRole("button", { name: /Show dashboard shortcut:.*D/ }).waitFor();
    await active.keyboard.press("Meta+Shift+D");
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("sidebar node trees collapse branches and highlight the virtual root", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Expand sidebar" }).click();
    await active.locator(".sidebar__project").hover();
    const treeToggle = active.getByRole("button", { name: "Show Visual verification fixture tree" });
    await treeToggle.waitFor({ state: "visible" });
    await treeToggle.click();

    const tree = active.locator(".sidebar-tree");
    await tree.locator(".sidebar-tree__node--virtual-root").waitFor();
    expect(await tree.locator(".sidebar-tree__node--virtual-root").getAttribute("aria-current")).toBe("location");

    const root = tree.locator("[role='treeitem']").first();
    const expandedCount = await tree.locator("[role='treeitem']").count();
    expect(await root.getAttribute("aria-expanded")).toBe("true");
    await root.getByRole("button", { name: "Collapse Dashboard" }).click();
    expect(await root.getAttribute("aria-expanded")).toBe("false");
    expect(await tree.locator("[role='treeitem']").count()).toBe(1);

    await root.getByRole("button", { name: "Expand Dashboard" }).click();
    expect(await root.getAttribute("aria-expanded")).toBe("true");
    expect(await tree.locator("[role='treeitem']").count()).toBe(expandedCount);

    const groupNode = tree.getByRole("button", { name: "Group", exact: true });
    await groupNode.click({ button: "right" });
    const nodeMenu = active.locator(".component-node__menu-popover");
    await nodeMenu.waitFor();
    expect(await nodeMenu.getByRole("menuitem", { name: "Edit component", exact: true }).count()).toBe(1);
    expect(await nodeMenu.evaluate((element) => element.parentElement === document.body)).toBe(true);
    await nodeMenu.getByRole("menuitem", { name: "Focus component", exact: true }).click();
    await tree.locator(".sidebar-tree__node--virtual-root").getByText("Group", { exact: true }).waitFor();

    expect(await tree.locator(".sidebar-tree__node--virtual-root").getByText("Group", { exact: true }).count()).toBe(1);
    await tree.getByRole("button", { name: "Dashboard", exact: true }).click();
    expect(await tree.locator(".sidebar-tree__node--virtual-root").getByText("Dashboard", { exact: true }).count()).toBe(1);
    await active.getByRole("button", { name: "Collapse sidebar" }).click();
  }, 20_000);

  test("Change with agent previews the dashboard template before sending", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      const frame = proof.locator('[data-node-id="responsive-card"]');
      await frame.waitFor();
      await frame.locator("header").first().click({ button: "right" });
      await proof.getByRole("menuitem", { name: "Change with agent…", exact: true }).click();
      const composer = proof.getByRole("dialog", { name: "Ask the agent" });
      await composer.waitFor();
      expect(await composer.getByRole("radio", { name: "Dashboard change" }).isChecked()).toBe(true);
      // The composer moves focus to the prompt after it opens.
      await composer.getByRole("textbox", { name: "Agent prompt" }).and(proof.locator(":focus")).waitFor();
      expect(await composer.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(false);
      await composer.getByRole("textbox", { name: "Agent prompt" }).fill("Add a status beside this tile.");
      await composer.getByRole("tab", { name: "Full prompt" }).click();
      const preview = composer.getByLabel("Full agent prompt");
      await waitForFullAgentPrompt(composer, "Add a status beside this tile.");
      const rendered = await preview.textContent();
      expect(rendered).toContain("Target component id: responsive-card");
      expect(rendered).toContain("User request:\nAdd a status beside this tile.");
      expect(await composer.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);

      // A bundle template switches scope, asks for its declared vars, and keeps the request.
      await composer.getByText("triage-item", { exact: true }).click();
      expect(await composer.getByRole("tab", { name: "Request" }).getAttribute("aria-selected")).toBe("true");
      // Choosing a template refocuses the prompt on the next frame; filling a var
      // before then sends its text into the prompt on a slow host.
      await composer.getByRole("textbox", { name: "Agent prompt" }).and(proof.locator(":focus")).waitFor();
      await composer.getByRole("textbox", { name: "id" }).fill("item-7");
      await composer.getByRole("tab", { name: "Full prompt" }).click();
      await waitForFullAgentPrompt(composer, "Triage backlog item `item-7`.");
      const projectPrompt = await preview.textContent();
      expect(projectPrompt).toContain("You were asked to do work in this project");
      expect(projectPrompt).toContain("Add a status beside this tile.");
      expect(projectPrompt).not.toContain("Target component id:");
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("agent work dropper picks a component for the change composer", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      const frame = proof.locator('[data-node-id="responsive-card"]');
      await frame.waitFor();
      const dropper = proof.getByRole("button", { name: "Pick a component to change with agent", exact: true });
      await dropper.click();
      expect(await dropper.getAttribute("aria-pressed")).toBe("true");
      await proof.keyboard.press("Escape");
      expect(await dropper.getAttribute("aria-pressed")).toBe("false");

      await dropper.click();
      await frame.locator("header").first().hover();
      const highlight = proof.locator(".component-picker__highlight");
      await highlight.waitFor();
      const box = await frame.boundingBox();
      await proof.waitForFunction((expected) => {
        const rect = document.querySelector(".component-picker__highlight")?.getBoundingClientRect();
        return rect !== undefined && Math.abs(rect.width - expected) < 1;
      }, box!.width);
      await frame.locator("header").first().click();
      const composer = proof.getByRole("dialog", { name: "Ask the agent" });
      await composer.waitFor();
      expect(await composer.getByRole("radio", { name: "Dashboard change" }).isChecked()).toBe(true);
      expect(await composer.locator(".agent-prompt__target code").textContent()).toContain("#");
      // The picker unmounts its highlight after the composer opens; wait for it.
      await highlight.waitFor({ state: "detached" });
      await composer.getByRole("textbox", { name: "Agent prompt" }).fill("Tighten this tile.");
      await composer.getByRole("tab", { name: "Full prompt" }).click();
      await composer.getByLabel("Full agent prompt").getByText("Target component id: responsive-card", { exact: false }).waitFor();
      // The pick swallowed the click, so the frame's own collapse gesture never ran.
      expect(await frame.getAttribute("data-collapsed")).toBe("false");

      // The agent picker offers the app setting, the bundle `.env`, each detected agent, and a custom command.
      const agentSelect = composer.getByRole("combobox", { name: "Agent", exact: true });
      const runs = composer.locator(".agent-prompt__runner code");
      await runs.getByText("bundle-agent", { exact: true }).waitFor();
      expect(await agentSelect.inputValue()).toBe("project");
      await agentSelect.selectOption("detected:codex");
      await runs.getByText("codex-acp", { exact: true }).waitFor();
      await agentSelect.selectOption("custom");
      const custom = composer.getByRole("textbox", { name: "Custom agent command" });
      await custom.fill("");
      expect(await composer.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(false);
      await custom.fill("gemini --acp");
      await composer.getByRole("button", { name: "Send", exact: true }).click();
      await proof.getByRole("status").getByText("Started gemini --acp for", { exact: false }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("agent work dropper Shift-selects several components and Shift release opens one composer", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      const tile = proof.locator('[data-node-id="responsive-card"]');
      const card = proof.locator('[data-node-id="renderer-proof-card"]');
      const status = proof.locator('[data-node-id="renderer-proof-status"]');
      await tile.waitFor();
      const dropper = proof.getByRole("button", { name: "Pick a component to change with agent", exact: true });
      const composer = proof.getByRole("dialog", { name: "Ask the agent" });
      const selected = proof.locator(".component-picker__highlight--selected");
      await dropper.click();
      await proof.keyboard.down("Shift");
      await tile.locator("header").first().click();
      await status.click();
      await card.locator("header").first().click();
      expect(await proof.locator(".component-picker__order").allTextContents()).toEqual(["1", "2", "3"]);
      // Clicking a selected component again unselects it; the rest keep their pick order.
      await tile.locator("header").first().click();
      await proof.waitForFunction(() => document.querySelectorAll(".component-picker__highlight--selected").length === 2);
      expect(await proof.locator(".component-picker__order").allTextContents()).toEqual(["1", "2"]);
      const statusBox = await status.boundingBox();
      const firstBox = await selected.first().boundingBox();
      expect(Math.abs(firstBox!.width - statusBox!.width)).toBeLessThan(1);
      expect(await dropper.getAttribute("aria-pressed")).toBe("true");
      expect(await composer.count()).toBe(0);

      // Releasing Shift accepts the selection in pick order.
      await proof.keyboard.up("Shift");
      await composer.waitFor();
      expect(await selected.count()).toBe(0);
      expect(await dropper.getAttribute("aria-pressed")).toBe("false");
      await composer.getByText("2 components", { exact: true }).waitFor();
      const targets = composer.getByRole("list", { name: "Target components" }).locator("code");
      expect((await targets.allTextContents()).map((locator) => locator.split("#").at(-1))).toEqual([
        "root.children[0].node.children.first.node.children.first.node",
        "root.children[0].node.children.first.node",
      ]);
      await composer.getByRole("textbox", { name: "Agent prompt" }).fill("Line these up.");
      await composer.getByRole("tab", { name: "Full prompt" }).click();
      const preview = composer.getByLabel("Full agent prompt");
      await preview.getByText("Target components:", { exact: false }).waitFor();
      const rendered = (await preview.textContent())!;
      expect(rendered).toContain("from several of its components.");
      expect(rendered.indexOf("id `renderer-proof-status`")).toBeLessThan(rendered.indexOf("id `renderer-proof-card`"));
      expect(rendered).not.toContain("responsive-card");
      // Every pick swallowed its click, so no frame's own collapse gesture ran.
      expect(await card.getAttribute("data-collapsed")).toBe("false");
      expect(await tile.getAttribute("data-collapsed")).toBe("false");
      await composer.getByRole("button", { name: "Send", exact: true }).click();
      await proof.getByRole("status").getByText("children.first.node.children.first.node and 1 more.", { exact: false }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("agent work shows a dispatched request as a session with its prompt and closes it", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open agent work" }).click();
    const activity = active.getByRole("dialog", { name: "Agent work" });
    await activity.waitFor();
    const taskId = await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return (await host.launchAgent({ kind: "component", nodeIds: ["status"], prompt: "Show a clearer fixture state." })).taskId;
    });
    const task = activity.locator(`[data-task-id="${taskId}"]`);
    await task.waitFor();
    expect(await task.getByText("Show a clearer fixture state.", { exact: true }).count()).toBe(1);
    expect(await task.locator("time").count()).toBe(1);
    expect(await task.getByText("bundle-agent", { exact: true }).count()).toBe(1);
    await task.getByText("Working", { exact: true }).waitFor();
    await task.click();
    const session = active.getByRole("dialog", { name: "Agent session" });
    await session.getByRole("log", { name: "Agent transcript" }).getByText("Reading the dashboard and the request…", { exact: true }).waitFor();
    expect(await session.getByRole("tab").count()).toBe(2);
    expect(await session.getByRole("tab", { name: "Session", exact: true }).getAttribute("aria-selected")).toBe("true");
    await session.getByRole("tab", { name: "Prompt", exact: true }).click();
    expect(await session.locator(".agent-task-modal__launch").textContent()).toBe("bundle-agent");
    expect(await session.locator(".agent-task-modal__prompt-text").textContent()).toContain("Show a clearer fixture state.");
    await session.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await session.getByRole("button", { name: "Copied", exact: true }).waitFor();
    await session.getByRole("tab", { name: "Session", exact: true }).click();
    await session.getByRole("button", { name: "Close session", exact: true }).click();
    await task.getByText("Closed", { exact: true }).waitFor();
    expect(await session.getByRole("button", { name: "Close session", exact: true }).count()).toBe(0);
    expect(await session.getByRole("textbox", { name: "Follow-up message" }).count()).toBe(0);
    await session.getByRole("button", { name: "Close", exact: true }).click();
    await activity.getByRole("button", { name: "Close", exact: true }).click();
    expect(await activity.count()).toBe(0);
  }, 20_000);

  test("notifications are read on screen, interrupt elsewhere, stay open after Show, and close into Earlier", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      // The status node is on screen: its decision is marked read and no notice appears.
      await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.raiseNotification({
        key: "run:status", kind: "run-failed", title: "Renderer fixture failed", message: "Exited with code 1.",
        target: { kind: "node", nodeId: "status" },
      }));
      await proof.waitForFunction(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getNotificationCommands().length === 1);
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getNotificationCommands()))
        .toEqual([{ type: "read", ids: ["fixture-notification-1"] }]);
      expect(await proof.locator(".decision-notice").count()).toBe(0);
      expect(await proof.locator(".sidebar__notification-mark").count()).toBe(0);
      await proof.getByRole("button", { name: "Open notifications, 1 read and still open", exact: true }).waitFor();

      // A node on the hidden Boundary tab interrupts with a decision notice and marks the dashboard.
      await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.raiseNotification({
        key: "run:boundary", kind: "run-failed", title: "Renderer boundary failed", message: "Exited with code 2.",
        target: { kind: "node", nodeId: "boundary-status" },
        action: { label: "Fix with agent", invocation: { run: "agent:prompt", with: { prompt: "Fix the boundary run." } } },
      }));
      const notice = proof.locator(".decision-notice");
      await notice.getByText("Renderer boundary failed", { exact: true }).waitFor();
      expect(await notice.getAttribute("data-level")).toBe("interrupt");
      expect(await notice.getByRole("button").allTextContents()).toEqual(["Show", "Fix with agent", "Dismiss"]);
      await proof.getByRole("status").filter({ hasText: "Needs you: Renderer boundary failed." }).waitFor({ state: "attached" });
      expect(await proof.locator(".sidebar__notification-mark").getAttribute("data-level")).toBe("interrupt");
      const dashboardButton = proof.getByRole("button", { name: "Visual verification fixture", exact: true });
      expect(await dashboardButton.getAttribute("aria-describedby")).toBeTruthy();

      // Escape hides the notice without deciding; the inbox still lists the decision, unread.
      await notice.getByRole("button", { name: "Show" }).focus();
      await proof.keyboard.press("Escape");
      expect(await notice.count()).toBe(0);
      const trigger = proof.getByRole("button", { name: "Open notifications, 1 needs you, 1 read and still open", exact: true });
      await trigger.click();
      const inbox = proof.getByRole("dialog", { name: "Notifications" });
      const row = inbox.locator('.notification-row[data-notification-id="fixture-notification-2"]');
      await row.getByText("Visual verification fixture", { exact: true }).waitFor();
      expect(await row.getAttribute("data-read")).toBe("false");
      expect(await inbox.locator('.notification-row[data-notification-id="fixture-notification-1"]').getAttribute("data-read")).toBe("true");
      expect(await row.locator("time").count()).toBe(1);

      // Show lands on the component and keeps the decision open, read, with its action and Dismiss.
      await row.getByRole("button", { name: "Show" }).click();
      await inbox.waitFor({ state: "hidden" });
      await proof.waitForFunction(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getNotificationCommands()
        .some((command) => command.type === "read" && command.ids.includes("fixture-notification-2")));
      expect(await proof.locator(".sidebar__notification-mark").count()).toBe(0);
      await proof.getByRole("button", { name: "Open notifications, 2 read and still open", exact: true }).click();
      await inbox.waitFor();
      expect(await row.getAttribute("data-read")).toBe("true");
      expect(await row.getByRole("button").allTextContents()).toEqual(["Show", "Fix with agent", "Dismiss"]);

      // Dismissing, or the cause clearing, moves an entry to Earlier and says which happened.
      await row.getByRole("button", { name: "Dismiss" }).click();
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getNotificationCommands().at(-1)))
        .toEqual({ type: "dismiss", ids: ["fixture-notification-2"] });
      await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.resolveNotification("run:status"));
      await inbox.getByText(/^Nothing needs you\./).waitFor();
      const earlier = inbox.getByRole("region", { name: "Earlier" });
      const closed = earlier.locator(".notification-row");
      await closed.nth(1).waitFor();
      expect(await closed.evaluateAll((rows) => rows.map((element) => [
        element.querySelector("strong")?.textContent,
        element.querySelector(".notification-row__outcome")?.textContent,
      ]))).toEqual([["Renderer fixture failed", "Cleared"], ["Renderer boundary failed", "Dismissed"]]);
      expect(await closed.first().getByRole("button").allTextContents()).toEqual(["Show"]);
      await earlier.getByRole("button", { name: "Clear 2 earlier notifications" }).click();
      await earlier.waitFor({ state: "detached" });
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getNotificationCommands().at(-1)))
        .toEqual({ type: "clear-history" });
      await inbox.getByRole("button", { name: "Close notifications" }).click();
      await proof.getByRole("button", { name: "Open notifications", exact: true }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("diagnostics details can ask the configured agent to fix the dashboard", async () => {
    const active = currentPage();
    await active.setViewportSize({ width: 390, height: 844 });
    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.setDiagnostics([{
        severity: "error",
        code: "FIXTURE_INVALID",
        message: "The fixture configuration needs attention.",
        path: "root.component",
      }]);
    });

    const diagnostics = active.locator("details.diagnostics");
    const fixButton = diagnostics.getByRole("button", { name: "Fix with agent", exact: true });
    await fixButton.waitFor();
    expect(await fixButton.boundingBox()).not.toBeNull();
    await fixButton.click();
    const activity = active.getByRole("dialog", { name: "Agent work" });
    await activity.waitFor();
    const task = activity.locator(".agent-task").first();
    await task.waitFor();
    await task.click();
    const command = active.getByRole("dialog", { name: "Agent session" });
    await command.locator(".agent-task-modal__request").getByText("Fix dashboard configuration diagnostics.", { exact: true }).waitFor();
    expect(await command.getByText("/ui-harness/.dash-bored/dash-bored.yaml#diagnostics", { exact: true }).count()).toBe(1);
    await command.getByRole("button", { name: "Close session", exact: true }).click();
    await task.getByText("Closed", { exact: true }).waitFor();
    await command.getByRole("button", { name: "Close", exact: true }).click();

    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.setDiagnostics([]);
    });
    await activity.getByRole("button", { name: "Close", exact: true }).click();
    await active.setViewportSize({ width: 1280, height: 800 });
  }, 20_000);

  test("installed-tool conflicts can be replaced without launching an agent", async () => {
    const active = currentPage();
    await active.setViewportSize({ width: 390, height: 844 });
    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.setDiagnostics([
        {
          severity: "warning",
          code: "INSTALLED_TOOL_UPDATE_CONFLICT",
          file: "/Users/fixture/.agents/skills/dash-bored",
          message: "The installed skill has local changes.",
        },
        {
          severity: "warning",
          code: "INSTALLED_TOOL_UPDATE_CONFLICT",
          file: "/Users/fixture/.local/bin/dash-bored",
          message: "The installed CLI link points to another executable.",
        },
      ]);
    });

    const diagnostics = active.locator("details.diagnostics");
    await diagnostics.getByText("Installed tools", { exact: true }).waitFor();
    const repair = diagnostics.getByRole("button", { name: "Remove old and reinstall", exact: true });
    await repair.waitFor();
    const tasksBefore = await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return (await host.getAgentTasks()).length;
    });
    await repair.click();
    await active.getByRole("status").getByText("Moved the old installed tools to Trash and installed the current dash-bored tools.", { exact: true }).waitFor();
    expect(await diagnostics.count()).toBe(0);
    expect(await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return (await host.getAgentTasks()).length;
    })).toBe(tasksBefore);
    await active.setViewportSize({ width: 1280, height: 800 });
  }, 20_000);

  test("visible components resize only downward from intrinsic height and keep their frame chrome visible", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    expect(await active.getByRole("separator", { name: "Resize Group height" }).count()).toBe(0);
    expect(await active.locator(".split--vertical > .split__separator").count()).toBe(0);

    const frame = active.locator('[data-node-id="renderer-proof-card"]');
    const card = frame.locator(":scope > .component-node__viewport > .card");
    const handle = active.getByRole("separator", { name: "Resize Renderer proof height" });
    await frame.scrollIntoViewIfNeeded();
    const initial = await frame.boundingBox();
    const handleBox = await handle.boundingBox();
    if (!initial || !handleBox) throw new Error("Component resize geometry is unavailable.");

    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 48, { steps: 4 });
    await active.mouse.up();

    const compressed = await frame.boundingBox();
    const compressedCard = await card.boundingBox();
    if (!compressed || !compressedCard) throw new Error("Compressed component geometry is unavailable.");
    expect(compressed.height).toBeLessThan(initial.height - 30);
    expect(compressedCard.y).toBeCloseTo(compressed.y, 0);
    expect(compressedCard.y + compressedCard.height).toBeCloseTo(compressed.y + compressed.height, 0);
    expect(await card.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    expect(await active.locator(".split--vertical .split__pane").evaluateAll((panes) => (
      panes.every((pane) => getComputedStyle(pane).overflowY === "visible")
    ))).toBeTrue();

    const compressedHandleBox = await handle.boundingBox();
    if (!compressedHandleBox) throw new Error("Compressed resize control is unavailable.");
    await active.mouse.move(compressedHandleBox.x + compressedHandleBox.width / 2, compressedHandleBox.y + compressedHandleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(compressedHandleBox.x + compressedHandleBox.width / 2, compressedHandleBox.y + initial.height, { steps: 5 });
    await active.mouse.up();

    const restored = await frame.boundingBox();
    if (!restored) throw new Error("Restored component geometry is unavailable.");
    expect(restored.height).toBeCloseTo(initial.height, 0);
    expect(restored.height).toBeLessThanOrEqual(initial.height + 1);
    expect(await handle.getAttribute("aria-valuetext")).toBe("Full height");

    await handle.press("Home");
    const minimum = await frame.boundingBox();
    if (!minimum) throw new Error("Minimum component geometry is unavailable.");
    expect(minimum.height).toBeLessThan(restored.height);
    await handle.press("End");
    expect((await frame.boundingBox())?.height).toBeCloseTo(initial.height, 0);
    expect(await active.evaluate(() => window.localStorage.getItem(
      "dash-bored:component-heights:/ui-harness/.dash-bored/dash-bored.yaml",
    ))).toBe("{}");
  }, 20_000);

  test("right-click menu edits a component and stays above dashboard content", async () => {
    const active = currentPage();
    const card = active.locator('[data-node-id="renderer-proof-card"]');
    await card.locator("header").first().click({ button: "right" });

    const menu = active.locator(".component-node__menu-popover");
    await menu.waitFor();
    expect(await menu.getByRole("menuitem", { name: "Edit component", exact: true }).count()).toBe(1);
    expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true);

    const box = await menu.boundingBox();
    if (!box) throw new Error("Component menu geometry is unavailable.");
    expect(await active.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest(".component-node__menu-popover") === document.querySelector(".component-node__menu-popover");
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true);

    await menu.getByRole("menuitem", { name: "Edit component", exact: true }).click();
    const configure = active.getByRole("dialog", { name: "Configure component" });
    await configure.getByRole("heading", { name: "Configure component" }).waitFor();
    expect(await configure.getByRole("checkbox", { name: "Keep visible around focused components" }).isChecked()).toBeFalse();
    await configure.getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await persistedGroupCount()).toBe(0);
  }, 20_000);

  test("only the deepest hovered component reveals its menu and generated handle", async () => {
    const active = currentPage();
    const card = active.locator('[data-node-id="renderer-proof-card"]');
    const status = active.locator('[data-node-id="renderer-proof-status"]');
    const statusBox = await status.boundingBox();
    const cardHeaderBox = await card.locator("header").first().boundingBox();
    if (!statusBox || !cardHeaderBox) throw new Error("Nested control geometry is unavailable.");

    const assertControls = async (selected: string, hidden: string) => {
      await active.waitForFunction(({ selected, hidden }) => {
        const controls = (id: string) => [".component-node__menu", "[data-composition-drag-handle]"]
          .map((selector) => document.querySelector(`[data-node-id="${id}"] > ${selector}`));
        const matches = (id: string, opacity: string, pointerEvents: string) => controls(id).every((element) =>
          element && getComputedStyle(element).opacity === opacity && getComputedStyle(element).pointerEvents === pointerEvents);
        return matches(selected, "1", "auto") && matches(hidden, "0", "none");
      }, { selected, hidden });
      // Keep explicit assertions for both outputs; polling only synchronizes the transition.
      for (const [id, opacity, pointerEvents] of [[selected, "1", "auto"], [hidden, "0", "none"]]) {
        for (const selector of [".component-node__menu", "[data-composition-drag-handle]"]) {
          const control = active.locator(`[data-node-id="${id}"] > ${selector}`);
          expect(await control.evaluate((element) => getComputedStyle(element).opacity)).toBe(opacity!);
          expect(await control.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(pointerEvents!);
        }
      }
    };

    await active.mouse.move(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
    await assertControls("renderer-proof-status", "renderer-proof-card");
    await active.mouse.move(cardHeaderBox.x + cardHeaderBox.width / 2, cardHeaderBox.y + cardHeaderBox.height / 2);
    await assertControls("renderer-proof-card", "renderer-proof-status");
  });

  test("a left click outside the library closes it without beginning a draft", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();

    await active.locator('main.workspace[data-revision="1"]').click({ position: { x: 4, y: 4 } });

    await active.getByRole("button", { name: "Open component library" }).waitFor();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await persistedGroupCount()).toBe(0);
  }, 20_000);

  test("cancelling component insertion returns to the component library", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Group", exact: true }).click();
    await active.getByRole("heading", { name: "Add component" }).waitFor();
    await active.getByRole("dialog", { name: "Add component" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
  }, 20_000);

  test("clean component settings allow focus and follow external YAML changes", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const openSettings = async () => {
        await proof.locator('[data-node-id="renderer-proof-card"]').locator("header").first().click({ button: "right" });
        await proof.getByRole("menuitem", { name: "Edit component", exact: true }).click();
        await proof.getByRole("dialog", { name: "Configure component" }).waitFor();
      };
      await openSettings();
      expect(await proof.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
      await proof.getByRole("dialog", { name: "Configure component" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await proof.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
      await proof.getByRole("button", { name: /Open command palette/ }).click();
      const palette = proof.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("focus");
      const focus = palette.getByRole("option", { name: /Focus component/ });
      await focus.waitFor();
      expect(await focus.getAttribute("aria-disabled")).not.toBe("true");
      await focus.click();
      await palette.getByRole("combobox", { name: "Search focus component options" }).fill("Renderer proof");
      await palette.getByRole("option", { name: /^Renderer proof / }).waitFor();
      await proof.keyboard.press("Escape");
      await proof.keyboard.press("Escape");

      // Leave a clean session open while another writer publishes to YAML.
      await openSettings();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const source = await host.getDashboardConfigSource();
        source.config.name = "Agent updated dashboard";
        await host.saveDashboardConfig(source.config, source.configRevision);
      });
      await proof.locator(".app-header__title").getByText("Agent updated dashboard", { exact: true }).waitFor();
      await proof.getByRole("dialog", { name: "Configure component" }).waitFor({ state: "detached" });
      expect(await proof.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);

      // A subsequent real edit loads the new revision and saves without conflict.
      await addGroupDraft(proof);
      await proof.getByRole("button", { name: "Save dashboard", exact: true }).click();
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor({ state: "detached" });
      expect(await persistedGroupCount(proof)).toBe(1);
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig().name)).toBe("Agent updated dashboard");
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("reverting a dashboard edit removes Save and Cancel without a disk write", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const original = await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot());
      if (!original.config) throw new Error("Fixture dashboard configuration is unavailable.");
      await proof.getByRole("button", { name: "Open component library", exact: true }).click();
      await proof.getByText("Dashboard appearance", { exact: true }).click();
      await proof.getByRole("combobox", { name: "Dashboard appearance", exact: true }).selectOption("light");
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor();
      await proof.getByRole("combobox", { name: "Dashboard appearance", exact: true }).selectOption("");
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor({ state: "detached" });
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig())).toEqual(original.config);
      expect((await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot())).configRevision).toBe(original.configRevision);

      // A reload while dirty stays protected, then reverting releases the old
      // preview even though that host reload already happened.
      await proof.getByRole("combobox", { name: "Dashboard appearance", exact: true }).selectOption("light");
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const source = await host.getDashboardConfigSource();
        source.config.name = "Updated while editing";
        await host.saveDashboardConfig(source.config, source.configRevision);
      });
      expect(await proof.getByRole("region", { name: "Dashboard editor" }).count()).toBe(1);
      await proof.getByRole("combobox", { name: "Dashboard appearance", exact: true }).selectOption("");
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor({ state: "detached" });
      await proof.getByRole("dialog", { name: "Component library" }).waitFor({ state: "detached" });
      await addGroupDraft(proof);
      await proof.getByRole("button", { name: "Save dashboard", exact: true }).click();
      await proof.getByRole("region", { name: "Dashboard editor" }).waitFor({ state: "detached" });
      expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig().name)).toBe("Updated while editing");
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("structural mutation starts a draft, save persists, and cancel restores", async () => {
    expect(await persistedGroupCount()).toBe(0);
    await addGroupDraft();

    expect(await persistedGroupCount()).toBe(0);
    await currentPage().getByRole("button", { name: "Save dashboard" }).click();
    await currentPage().locator('main.workspace[data-revision="2"]').waitFor();
    expect(await persistedGroupCount()).toBe(1);

    await addGroupDraft();
    await currentPage().getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await currentPage().getByRole("button", { name: "Discard changes", exact: true }).click();
    await currentPage().getByRole("button", { name: "Open component library" }).waitFor();
    expect(await persistedGroupCount()).toBe(1);
  }, 20_000);

  test("frame menu sibling moves preview immediately and use dashboard Save and Cancel", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library" }).waitFor();
      const original = await persistedResponsiveSiblingOrder(proof);
      expect(original.indexOf("status")).toBeLessThan(original.indexOf("responsive-card"));

      const moveUp = async (): Promise<void> => {
        const frame = proof.locator('[data-node-id="responsive-card"]');
        await frame.locator("header").first().click({ button: "right" });
        await proof.getByRole("menuitem", { name: "Move component up", exact: true }).click();
        await proof.getByRole("button", { name: "Save dashboard" }).waitFor();
        await proof.waitForFunction(() => {
          const ids = [...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((node) => node.dataset.nodeId);
          return ids.indexOf("responsive-card") >= 0 && ids.indexOf("responsive-card") < ids.indexOf("status");
        });
      };

      await moveUp();
      expect(await persistedResponsiveSiblingOrder(proof)).toEqual(original);
      await proof.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await proof.getByRole("button", { name: "Discard changes", exact: true }).click();
      expect(await persistedResponsiveSiblingOrder(proof)).toEqual(original);

      await moveUp();
      await proof.getByRole("button", { name: "Save dashboard" }).click();
      await proof.locator('main.workspace[data-revision="2"]').waitFor();
      const saved = await persistedResponsiveSiblingOrder(proof);
      expect(saved.indexOf("responsive-card")).toBeLessThan(saved.indexOf("status"));
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("invalid composition draft shows host diagnostics in place and disables Save", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library" }).click();
      await proof.getByRole("button", { name: "Insert Markdown", exact: true }).click();
      const dialog = proof.getByRole("dialog", { name: "Add component" });
      await dialog.getByRole("button", { name: "Add component", exact: true }).click();
      await proof.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
      await proof.getByText("The draft has not resolved yet. The saved dashboard remains visible while it is checked.", { exact: true }).waitFor();
      const diagnostics = proof.locator("details.diagnostics");
      await diagnostics.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
      await diagnostics.getByText(/match exactly one schema in oneOf/).waitFor();
      expect(await proof.getByRole("button", { name: "Save dashboard" }).isDisabled()).toBeTrue();
      expect(await proof.getByRole("region", { name: "Selected component actions" }).count()).toBe(0);
      await proof.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await proof.getByRole("button", { name: "Discard changes", exact: true }).click();
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("the first todo prop update from a fresh page opens and updates its owner draft", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library" }).waitFor();
      await proof.getByRole("tab", { name: "Boundary", exact: true }).click({ force: true });
      const toggle = proof.getByRole("checkbox", { name: "Mark complete: Keep this surface mounted" });
      await toggle.waitFor();
      await toggle.click();
      await proof.getByRole("button", { name: "Save dashboard" }).waitFor();
      const completed = proof.getByRole("checkbox", { name: "Mark incomplete: Keep this surface mounted" });
      await completed.waitFor();
      expect(await completed.isChecked()).toBeTrue();
      expect(await persistedTodoDone(proof)).toBeFalse();
      await proof.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await proof.getByRole("button", { name: "Discard changes", exact: true }).click();
      await proof.getByRole("checkbox", { name: "Mark complete: Keep this surface mounted" }).waitFor();
      expect(await persistedTodoDone(proof)).toBeFalse();
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("discard confirmation can save the draft before continuing", async () => {
    // A fresh page has its own fixture host, so this save does not shift the
    // revisions and group counts the shared-page tests below depend on.
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const before = await persistedGroupCount(proof);
      await addGroupDraft(proof);
      await proof.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
      const confirmation = proof.getByRole("dialog", { name: "Discard dashboard changes?" });
      await confirmation.getByRole("button", { name: "Save dashboard", exact: true }).click();
      await confirmation.waitFor({ state: "detached" });
      expect(await persistedGroupCount(proof)).toBe(before + 1);
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("an incompatible pointer drop does not mutate the draft or persisted fixture", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Group", exact: true });
    // The app header is outside the managed component tree, so it exposes no pointer insertion boundary.
    const target = active.locator(".app-header");
    await source.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error("Fixture drag geometry is unavailable.");

    // Without a confirmed start, a missed press would pass this test vacuously.
    await startLibraryDrag(active, source);
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 });
    await active.waitForTimeout(250);
    await active.mouse.up();

    const library = active.getByRole("dialog", { name: "Component library" });
    await library.waitFor();
    expect(await active.getByRole("heading", { name: "Add component" }).count()).toBe(0);
    expect(await active.locator(".component-node--drop-ready").count()).toBe(0);
    expect(await active.getByRole("button", { name: "Insert Group", exact: true }).getAttribute("aria-grabbed")).toBe("false");
    expect(await persistedGroupCount()).toBe(1);
    await library.getByRole("button", { name: "Close Component library", exact: true }).click();
  }, 20_000);

  test("dragging advertises one compatible insertion edge inside the hovered card", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Group", exact: true });
    const target = active.locator('[data-node-id="renderer-proof-card"]');
    await source.scrollIntoViewIfNeeded();

    await startLibraryDrag(active, source);
    const { indicator, targetBox } = await moveLibraryDragToBottomEdge(active, target);
    const indicatorBox = await indicator.boundingBox();
    if (!indicatorBox) throw new Error("Drop-indicator geometry is unavailable.");
    expect(indicatorBox.y).toBeGreaterThanOrEqual(targetBox.y);
    expect(indicatorBox.y + indicatorBox.height).toBeLessThanOrEqual(targetBox.y + targetBox.height);
    expect(await indicator.textContent()).toContain("Tile below");
    expect(await active.locator(".composition-drop-indicator").count()).toBe(1);
    await active.mouse.up();
    await active.getByRole("heading", { name: "Add component" }).waitFor();
    await active.getByRole("dialog", { name: "Add component" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
  }, 20_000);

  test("generated frame handle moves a component without component-owned drag markup", async () => {
    const active = currentPage();
    const source = active.locator('[data-node-id="renderer-proof-status"]');
    const target = active.locator('[data-node-id="responsive-card"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Generated handle drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + 12, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(150);
    const handle = source.locator(":scope > [data-composition-drag-handle]");
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("Generated component drag handle is unavailable.");
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + 12, targetBox.y + targetBox.height / 2, { steps: 5 });
    await target.locator(":scope > .composition-drop-indicator--left").waitFor();
    expect(await source.getAttribute("data-composition-drag-source")).toBe("true");
    expect(await active.locator(".composition-drop-indicator").count()).toBe(1);
    await active.mouse.up();

    await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Discard dashboard changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("a generated frame handle supports pointer moves without opening the library first", async () => {
    const active = currentPage();
    const beforeMove = await active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    });
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    const source = active.locator('[data-node-id="renderer-proof-card"]');
    const target = active.locator('[data-node-id="responsive-card"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Move handle geometry is unavailable.");

    await active.mouse.move(sourceBox.x + 12, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(150);
    const dragHandle = source.locator(":scope > [data-composition-drag-handle]");
    const handleBox = await dragHandle.boundingBox();
    if (!handleBox) throw new Error("Move handle geometry is unavailable.");
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + 12, targetBox.y + targetBox.height / 2, { steps: 5 });
    await active.waitForTimeout(100);
    const indicator = target.locator(":scope > .composition-drop-indicator--left");
    await indicator.waitFor();
    const placementPreview = indicator.locator(".composition-drop-indicator__preview");
    await placementPreview.waitFor();
    expect(await active.locator(".composition-drop-indicator").count()).toBe(1);
    expect(await source.getAttribute("data-composition-drag-source")).toBe("true");
    expect(await source.getAttribute("aria-grabbed")).toBe("true");
    expect(await source.evaluate((element) => getComputedStyle(element).userSelect)).toBe("none");
    expect(await active.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    expect(await placementPreview.textContent()).toContain("Moving");
    expect(await placementPreview.textContent()).toContain("Renderer proof");
    expect(await placementPreview.textContent()).toContain("Tile left");
    expect(await active.evaluate(({ x, y }) => ({
      node: document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId,
    }), {
      x: targetBox.x + 12,
      y: targetBox.y + targetBox.height / 2,
    })).toMatchObject({ node: "responsive-card" });
    await active.mouse.up();

    await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
    await active.getByRole("button", { name: "Save dashboard" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard" }).click();
    await active.locator('main.workspace[data-revision="3"]').waitFor();
    expect(await active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    })).not.toBe(beforeMove);
  }, 20_000);

  test("a cursor chip follows a frame drag and Escape cancels it without a drop", async () => {
    const active = currentPage();
    const persisted = () => active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    });
    const beforeDrag = await persisted();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    const source = active.locator('[data-node-id="renderer-proof-card"]');
    const target = active.locator('[data-node-id="responsive-card"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Cancel drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + 12, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(150);
    const handleBox = await source.locator(":scope > [data-composition-drag-handle]").boundingBox();
    if (!handleBox) throw new Error("Cancel drag handle is unavailable.");
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + 12, targetBox.y + targetBox.height / 2, { steps: 5 });
    await target.locator(":scope > .composition-drop-indicator--left").waitFor();
    const chip = active.locator(".composition-drag-chip");
    await chip.waitFor();
    expect(await chip.getAttribute("data-state")).toBe("target");
    expect(await chip.textContent()).toContain("Renderer proof");
    expect(await chip.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    await active.keyboard.press("Escape");
    await chip.waitFor({ state: "detached" });
    expect(await active.locator(".composition-drop-indicator").count()).toBe(0);
    expect(await source.getAttribute("data-composition-drag-source")).toBeNull();
    await active.mouse.up();
    await active.waitForTimeout(150);
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await active.getByRole("dialog", { name: "Component library" }).count()).toBe(0);
    expect(await persisted()).toBe(beforeDrag);
  }, 20_000);

  test("dragging a component handle to the removal surface opens confirmation", async () => {
    const active = currentPage();
    const source = active.locator('[data-node-id="renderer-proof-card"]');
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    if (!sourceBox) throw new Error("Removal handle geometry is unavailable.");

    await active.mouse.move(sourceBox.x + 12, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(150);
    const dragHandle = source.locator(":scope > [data-composition-drag-handle]");
    const handleBox = await dragHandle.boundingBox();
    if (!handleBox) throw new Error("Removal handle geometry is unavailable.");
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(handleBox.x + handleBox.width + 24, handleBox.y + handleBox.height / 2, { steps: 3 });
    const removal = active.locator("[data-composition-removal-target]");
    await removal.waitFor();
    await active.waitForTimeout(250);
    const removalBox = await removal.boundingBox();
    if (!removalBox) throw new Error("Removal target geometry is unavailable.");
    expect(removalBox.width).toBeCloseTo((await active.evaluate(() => window.innerWidth)) * 0.2, 0);
    await active.mouse.move(removalBox.x + removalBox.width / 2, removalBox.y + removalBox.height / 2, { steps: 5 });
    await active.mouse.up();

    const confirmation = active.locator(".editor-modal__panel");
    await confirmation.waitFor();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("pointer and keyboard insertions both enter the same draft-and-save boundary", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Group", exact: true });
    const target = active.locator('[data-node-id="renderer-proof-card"]');
    await target.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();

    await startLibraryDrag(active, source);
    await moveLibraryDragToBottomEdge(active, target);
    await active.mouse.up();

    await submitAddComponentWithEnter(active);
    await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    expect(await active.getByRole("button", { name: "Save dashboard" }).count()).toBe(1);
    expect(await active.getByRole("button", { name: "Cancel", exact: true }).count()).toBeGreaterThan(0);
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard" }).click();
    await active.locator('main.workspace[data-revision="4"]').waitFor();
    expect(await persistedGroupCount()).toBe(2);
  }, 30_000);

  test("confirmed component removal from its handle reopens the component library", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();

    const card = active.locator('[data-node-id="renderer-proof-card"]');
    await card.scrollIntoViewIfNeeded();
    const cardBox = await card.boundingBox();
    if (!cardBox) throw new Error("Removal handle geometry is unavailable.");
    await active.mouse.move(cardBox.x + 12, cardBox.y + cardBox.height / 2);
    await active.waitForTimeout(150);
    const dragHandle = card.locator(":scope > [data-composition-drag-handle]");
    const handleBox = await dragHandle.boundingBox();
    if (!handleBox) throw new Error("Removal handle geometry is unavailable.");
    await active.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(handleBox.x + handleBox.width + 24, handleBox.y + handleBox.height / 2, { steps: 3 });
    const removal = active.locator("[data-composition-removal-target]");
    await removal.waitFor();
    const removalBox = await removal.boundingBox();
    if (!removalBox) throw new Error("Removal target geometry is unavailable.");
    await active.mouse.move(removalBox.x + removalBox.width / 2, removalBox.y + removalBox.height / 2, { steps: 5 });
    await active.mouse.up();
    const confirmation = active.locator(".editor-modal__panel");
    await confirmation.getByRole("button", { name: "Remove", exact: true }).click();

    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
  }, 20_000);

  test("a host revision conflict keeps the draft visible and blocks save", async () => {
    await addGroupDraft();
    const revision = await currentPage().evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      const source = await host.getDashboardConfigSource();
      await host.saveDashboardConfig(source.config, source.configRevision);
      return (await host.getSnapshot()).configRevision;
    });
    expect(revision).toBe("ui-harness-5");

    await currentPage().getByRole("button", { name: "Save dashboard" }).click();
    await currentPage().getByRole("alert").filter({ hasText: "DASHBOARD_CONFIG_CONFLICT" }).waitFor();
    expect(await currentPage().getByRole("region", { name: "Dashboard editor" }).count()).toBe(1);
    expect(await persistedGroupCount()).toBe(2);
  }, 20_000);

  test("loads the external command and its CSS when a fresh snapshot needs it", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const moduleRequested = () => proof.evaluate(() => Boolean(document.querySelector('style[data-dash-bored-component^="dash-bored-component:core/command:"]')));
      expect(await moduleRequested()).toBe(false);
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 4, name: "Lazy command proof", root: {
          id: "lazy-command", component: "./components/external/core/command", props: { label: "Command", command: "printf fixture" },
        } }, snapshot.configRevision!);
      });
      await proof.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
      expect(await moduleRequested()).toBe(true);
      await proof.getByRole("button", { name: "Open terminal", exact: true }).click();
      await proof.locator(".command__terminal .xterm").waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

  test("inserted commands mount their generated frame and interactive terminal", async () => {
    const active = currentPage();
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Discard dashboard changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
    const commandModuleRequested = async (): Promise<boolean> => active.evaluate(() =>
      Boolean(document.querySelector('style[data-dash-bored-component^="dash-bored-component:core/command:"]')));

    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Command", exact: true }).click();

    const dialog = active.getByRole("dialog", { name: "Add component" });
    await dialog.waitFor();
    await dialog.getByLabel(/^label/i).first().fill("Fixture command");
    await dialog.getByLabel(/^command/i).fill("printf fixture");
    await dialog.getByRole("button", { name: "Add component", exact: true }).click();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await active.locator('main.workspace[data-revision="6"]').waitFor();
    await active.getByRole("tab", { name: "Item 4", exact: true }).click();
    await active.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
    expect(await active.locator('[data-node-id="command"] > [data-composition-drag-handle]').count()).toBe(1);
    expect(await commandModuleRequested()).toBe(true);
    await active.getByRole("button", { name: "Open terminal", exact: true }).click();
    await active.locator(".command__terminal .xterm").waitFor();
  }, 20_000);

  test("terminal process updates do not restart unrelated custom component effects", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Boundary", exact: true }).click();
    const effectRuns = active.getByTestId("local-host-effect-runs");
    await effectRuns.waitFor();
    await active.waitForTimeout(100);
    const beforeProcessUpdate = await effectRuns.textContent();
    expect(beforeProcessUpdate).toMatch(/^Host effects [1-9][0-9]*$/);

    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.processCommand("terminal-stream", { type: "open" });
    });

    await active.waitForTimeout(100);
    expect(await effectRuns.textContent()).toBe(beforeProcessUpdate);
  }, 20_000);

  test("loads the external Markdown renderer when it is inserted", async () => {
    const active = currentPage();
    const markdownModuleRequested = async (): Promise<boolean> => active.evaluate(() =>
      Boolean(document.querySelector('style[data-dash-bored-component^="dash-bored-component:core/markdown:"]')));

    expect(await markdownModuleRequested()).toBe(false);
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Markdown", exact: true }).click();

    const dialog = active.getByRole("dialog", { name: "Add component" });
    await dialog.waitFor();
    await dialog.getByLabel(/^content/i).fill("## Deferred Markdown\n\nLoaded on demand.");
    await dialog.getByRole("button", { name: "Add component", exact: true }).click();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await active.locator('main.workspace[data-revision="7"]').waitFor();
    await active.getByRole("tab", { name: "Item 5", exact: true }).click();
    await active.locator(".markdown").filter({ hasText: "Deferred Markdown" }).waitFor();
    expect(await markdownModuleRequested()).toBe(true);
  }, 20_000);

  test("renders a file-backed Markdown preview by default and saves Raw / edit changes", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Markdown", exact: true }).click();

    const dialog = active.getByRole("dialog", { name: "Add component" });
    await dialog.waitFor();
    await dialog.getByLabel(/^path/i).fill("README.md");
    await dialog.getByRole("button", { name: "Add component", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await active.locator('main.workspace[data-revision="8"]').waitFor();

    await active.getByRole("tab", { name: "Item 6", exact: true }).click();
    const viewer = active.getByRole("region", { name: "Markdown preview for README.md" });
    await viewer.waitFor();
    await viewer.getByRole("heading", { name: "Fixture document", exact: true }).waitFor();
    expect(await viewer.getByRole("button", { name: "Preview", exact: true }).getAttribute("aria-pressed")).toBe("true");

    await viewer.getByRole("button", { name: "Raw / edit", exact: true }).click();
    const editor = viewer.getByRole("textbox", { name: "Raw Markdown" });
    await editor.fill("# Updated fixture\n\nSaved from the raw editor.");
    await viewer.getByRole("button", { name: "Save changes", exact: true }).click();
    await viewer.getByRole("heading", { name: "Updated fixture", exact: true }).waitFor();

    const saved = await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return host.readTextFile({ nodeId: "markdown-file", path: "README.md" });
    });
    expect(saved).toBe("# Updated fixture\n\nSaved from the raw editor.");
  }, 20_000);

  test("source filters retain valid tags and permanently clear removed tags", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    const publish = async (phase: number): Promise<void> => {
      await proof.evaluate(async (phase) => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        const items = [
          { id: 'one', title: `Observation ${phase}`, tags: phase === 2 ? ['other'] : ['proof'] },
          { id: 'two', title: 'Other item', tags: ['other'] },
          ...(phase === 1 ? [{ id: 'three', title: 'New tag item', tags: ['new'] }] : []),
        ];
        host.runShell = async () => ({ stdout: JSON.stringify(items), stderr: '', exitCode: 0, signal: null, timedOut: false });
        await host.saveDashboardConfig({ schemaVersion: 4, name: 'Filter proof', root: {
          id: 'filter-list', component: './components/external/core/list', props: {
            title: 'Filter proof', source: phase < 4 ? { inline: items } : { shell: 'filter-proof', env: { PROVIDER: String(phase) } },
          },
        } }, snapshot.configRevision!);
      }, phase);
      await proof.getByText(`Observation ${phase}`, { exact: true }).waitFor();
    };
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole('button', { name: 'Open component library' }).waitFor();
      await publish(0);
      const tag = proof.getByRole('combobox', { name: 'Tag', exact: true });
      await tag.selectOption('proof');
      await publish(1);
      expect(await tag.inputValue()).toBe('proof');
      expect(await proof.getByText('Other item', { exact: true }).count()).toBe(0);
      await publish(2);
      expect(await tag.inputValue()).toBe('');
      await publish(3);
      expect(await tag.inputValue()).toBe('');
      await proof.getByText('Other item', { exact: true }).waitFor();
      await publish(4);
      await tag.selectOption('proof');
      await publish(5);
      expect(await tag.inputValue()).toBe('');
      await proof.getByText('Other item', { exact: true }).waitFor();
    } finally { await proof.close(); }
  }, 20_000);

  test("todo tag updates preserve the active edit buffer and keyboard focus", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    const publish = async (phase: number): Promise<void> => {
      await proof.evaluate(async (phase) => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 4, name: 'Todo filter proof', root: {
          id: 'filter-todos', component: './components/external/core/list', props: {
            filterByTags: phase !== 2,
            todos: [
              { id: 'one', description: 'Editing task', done: false, tags: ['proof'] },
              { id: 'two', description: 'Other task', done: false, tags: phase === 0 ? ['other'] : ['other', 'new'] },
            ],
          },
        } }, snapshot.configRevision!);
      }, phase);
    };
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole('button', { name: 'Open component library' }).waitFor();
      await publish(0);
      const tag = proof.getByRole('combobox', { name: 'Tag', exact: true });
      await tag.selectOption('proof');
      await proof.getByRole('button', { name: 'Edit description: Editing task', exact: true }).click();
      const editor = proof.getByRole('textbox', { name: 'Edit todo description', exact: true });
      await editor.fill('Uncommitted buffer');
      await editor.evaluate((element) => { (element as HTMLElement).dataset.focusProof = 'retained'; });
      await publish(1);
      await tag.locator('option[value="new"]').waitFor({ state: 'attached' });
      expect(await tag.inputValue()).toBe('proof');
      expect(await editor.inputValue()).toBe('Uncommitted buffer');
      expect(await editor.getAttribute('data-focus-proof')).toBe('retained');
      expect(await editor.evaluate((element) => document.activeElement === element)).toBeTrue();
      await editor.press('Escape');
      await publish(2);
      await proof.getByRole('button', { name: 'Edit description: Other task', exact: true }).waitFor();
      expect(await tag.count()).toBe(0);
    } finally { await proof.close(); }
  }, 20_000);

  test("todo interactions retain the mounted surface and use the dashboard draft", async () => {
    const active = currentPage();
    const boundaryTab = active.getByRole("tab", { name: "Boundary", exact: true });
    await boundaryTab.click({ force: true });
    expect(await boundaryTab.getAttribute("aria-selected")).toBe("true");
    const todo = active.getByRole("region", { name: /todo list/i });
    await todo.evaluate((element) => { (element as HTMLElement).dataset.fixtureMounted = "before-toggle"; });
    const toggle = active.getByRole("checkbox", { name: "Mark complete: Keep this surface mounted" });

    expect(await persistedTodoDone()).toBeFalse();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();

    await active.getByRole("button", { name: "Save dashboard" }).waitFor();
    expect(await active.getByRole("checkbox", { name: "Mark incomplete: Keep this surface mounted" }).isChecked()).toBeTrue();
    expect(await todo.getAttribute("data-fixture-mounted")).toBe("before-toggle");
    expect(await persistedTodoDone()).toBeFalse();

    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("button", { name: "Discard changes", exact: true }).click();
    await active.getByRole("checkbox", { name: "Mark complete: Keep this surface mounted" }).waitFor();
    expect(await persistedTodoDone()).toBeFalse();
  }, 20_000);

  test("setup agent inserts lazily, survives starter replacement, and shows validation truthfully", async () => {
    const proof = await openPage({ viewport: { width: 390, height: 844 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      expect(await proof.locator(".setup-agent").count()).toBe(0);
      await proof.getByRole("button", { name: "Open component library" }).click();
      await proof.getByRole("button", { name: "Insert Dashboard setup agent", exact: true }).click();
      await proof.getByRole("button", { name: "Add component", exact: true }).click();
      await proof.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
      await proof.getByRole("tab").last().click();
      await proof.getByRole("button", { name: "Save dashboard", exact: true }).click();
      const setup = proof.locator(".setup-agent");
      await setup.waitFor({ state: "attached" });
      const setupTab = await setup.locator("xpath=ancestor::*[@role='tabpanel'][1]").getAttribute("aria-labelledby");
      if (setupTab) await proof.locator(`[id="${setupTab}"]`).click();
      await setup.getByText("Runs bundle-agent", { exact: true }).waitFor();
      await setup.getByText("Command source: bundle", { exact: true }).waitFor();
      const bounds = await setup.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(390);
      await setup.getByRole("button", { name: "Set up this dashboard", exact: true }).click();
      const composer = proof.getByRole("dialog", { name: "Ask the agent" });
      await composer.waitFor();
      await composer.getByRole("button", { name: "Send", exact: true }).click();
      const activity = proof.getByRole("dialog", { name: "Agent work" });
      const row = activity.locator(".agent-task").first();
      await row.waitFor();
      expect(await row.getByText("Dashboard validated", { exact: true }).count()).toBe(0);
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 4, name: "Configured project", root: { id: "ready", component: "./components/external/core/status", props: { label: "Project ready", state: "healthy" } } }, snapshot.configRevision!);
      });
      expect(await proof.locator(".setup-agent").count()).toBe(0);
      await row.getByText("Working", { exact: true }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.finishAgentTask((await host.getAgentTasks())[0]!.id, { status: "trust-required", diagnostics: [], message: "Review newly requested permissions." });
      });
      await row.getByText("Review project trust", { exact: true }).waitFor();
      expect(await row.getByText("Dashboard validated", { exact: true }).count()).toBe(0);
      await row.click();
      const details = proof.getByRole("dialog", { name: "Agent session" });
      await details.getByText("Review newly requested permissions.", { exact: true }).waitFor();
      await details.getByRole("log", { name: "Agent transcript" }).getByText("Created project workflows and checked the dashboard.", { exact: false }).waitFor();
      await row.getByText("Idle", { exact: true }).waitFor();
      await proof.screenshot({ path: "/tmp/dash-bored-setup-proof.png", fullPage: true });
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("the follow-up composer opens when a turn ends, sends on Enter, and keeps Shift+Enter for new lines", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      const taskId = await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.launchAgent({ kind: "component",
        nodeIds: ["status"], prompt: "Interactive agent proof.",
      })).taskId);
      const row = proof.getByRole("dialog", { name: "Agent work" }).locator(`[data-task-id="${taskId}"]`);
      await row.getByText("Working", { exact: true }).waitFor();
      await row.click();
      const dialog = proof.getByRole("dialog", { name: "Agent session" });
      const followUp = dialog.getByRole("textbox", { name: "Follow-up message" });
      await followUp.waitFor();
      expect(await followUp.isDisabled()).toBe(true);
      expect(await dialog.getByRole("button", { name: "Stop", exact: true }).count()).toBe(1);

      await proof.evaluate(async (taskId) => window.__DASH_BORED_UI_HARNESS_HOST__!.finishAgentTask(taskId, { status: "valid", diagnostics: [] }), taskId);
      await row.getByText("Idle", { exact: true }).waitFor();
      await row.getByText("Dashboard validated", { exact: true }).waitFor();
      expect(await dialog.getByRole("button", { name: "Stop", exact: true }).count()).toBe(0);
      await proof.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Follow-up message"]')?.disabled === false);
      await followUp.click();
      await proof.keyboard.type("First line");
      await proof.keyboard.press("Shift+Enter");
      await proof.keyboard.type("Second line");
      expect(await followUp.inputValue()).toBe("First line\nSecond line");
      await proof.keyboard.press("Enter");
      const commands = () => proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTaskCommands());
      await proof.waitForFunction((taskId) => window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTaskCommands().some((entry) => entry.taskId === taskId), taskId);
      expect((await commands()).filter((entry) => entry.taskId === taskId).map((entry) => entry.command))
        .toEqual([{ type: "prompt", text: "First line\nSecond line" }]);
      expect(await followUp.inputValue()).toBe("");
      const transcript = dialog.getByRole("log", { name: "Agent transcript" });
      await transcript.locator(".agent-entry--user").getByText("Second line", { exact: false }).waitFor();
      await transcript.getByText("Done. I handled the follow-up: First line", { exact: true }).waitFor();
      await row.getByText("Idle", { exact: true }).waitFor();
      // Focus returns to the composer once the agent accepts follow-ups again.
      await proof.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Follow-up message");
      // Escape in the composer dismisses the modal like any other field.
      await proof.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    } finally { await proof.close(); }
  }, 20_000);

  test("long transcripts follow the tail, keep the reading position when scrolled up, and fit desktop and narrow widths", async () => {
    const prompt = "Set up the dash-bored dashboard for this project. " + "Inspect the project, preserve unrelated changes, and validate the cockpit. ".repeat(45);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const proof = await openPage({ viewport });
      proof.setDefaultTimeout(5_000);
      try {
        await proof.goto(fixtureUrl);
        await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
        const taskId = await proof.evaluate(async (prompt) => {
          const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
          const task = await host.launchAgent({ kind: "component", nodeIds: ["status"], prompt });
          await host.appendAgentMessage(task.taskId, Array.from({ length: 180 }, (_, i) => `Activity ${i}`).join("\n\n") + "\n\nLATEST BEFORE OPEN");
          return task.taskId;
        }, prompt);
        const row = proof.getByRole("dialog", { name: "Agent work" }).locator(`[data-task-id="${taskId}"]`);
        await row.waitFor();
        expect((await row.boundingBox())!.height).toBeLessThan(150);
        expect(await row.locator("strong").textContent()).toBe("Set up the dash-bored dashboard for this project.");
        await row.click();
        const dialog = proof.getByRole("dialog", { name: "Agent session" });
        const transcript = dialog.getByRole("log", { name: "Agent transcript" });
        await transcript.getByText("LATEST BEFORE OPEN", { exact: true }).waitFor();
        const atBottom = () => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
        const assertFit = async () => {
          const modalBox = (await dialog.boundingBox())!;
          const transcriptBox = (await transcript.boundingBox())!;
          const composerBox = (await dialog.getByRole("textbox", { name: "Follow-up message" }).boundingBox())!;
          expect(modalBox.y).toBeGreaterThanOrEqual(0);
          expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(viewport.height);
          expect(transcriptBox.height).toBeGreaterThan(150);
          expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(modalBox.y + modalBox.height);
          expect(await proof.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await assertFit();
        await proof.waitForFunction(() => {
          const element = document.querySelector(".agent-transcript");
          return element !== null && element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        });
        await proof.evaluate((taskId) => window.__DASH_BORED_UI_HARNESS_HOST__!.appendAgentMessage(taskId, "\n\nLATEST LIVE ACTIVITY"), taskId);
        await transcript.getByText("LATEST LIVE ACTIVITY", { exact: true }).waitFor();
        expect(await atBottom()).toBe(true);

        await transcript.hover();
        await proof.mouse.wheel(0, -900);
        await proof.waitForFunction(() => (document.querySelector(".agent-transcript")?.scrollTop ?? 0) > 0
          && document.querySelector(".agent-transcript")!.scrollHeight - document.querySelector(".agent-transcript")!.scrollTop - document.querySelector(".agent-transcript")!.clientHeight > 100);
        const readingPosition = await transcript.evaluate((element) => element.scrollTop);
        await proof.evaluate((taskId) => window.__DASH_BORED_UI_HARNESS_HOST__!.appendAgentMessage(taskId, "\n\nLATEST AFTER HISTORY"), taskId);
        await transcript.getByText("LATEST AFTER HISTORY", { exact: true }).waitFor({ state: "attached" });
        expect(await transcript.evaluate((element) => element.scrollTop)).toBe(readingPosition);
        await dialog.getByRole("button", { name: "Latest", exact: true }).click();
        expect(await atBottom()).toBe(true);
        await dialog.getByRole("button", { name: "Latest", exact: true }).waitFor({ state: "detached" });

        await dialog.getByRole("tab", { name: "Prompt", exact: true }).click();
        expect(await dialog.locator(".agent-task-modal__prompt-text").textContent()).toContain(prompt.trim());
        await dialog.getByRole("tab", { name: "Session", exact: true }).click();
        await transcript.getByText("LATEST AFTER HISTORY", { exact: true }).waitFor();
        expect(await atBottom()).toBe(true);
        await assertFit();
        await proof.screenshot({ path: `/tmp/dash-bored-agent-session-${viewport.width}.png` });
      } finally { await proof.close(); }
    }
  }, 30_000);

  test("modal scroll boundaries keep the background fixed and release it on dismissal", async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const proof = await openPage({ viewport });
      proof.setDefaultTimeout(5_000);
      try {
        await proof.goto(fixtureUrl);
        await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
        const taskId = await proof.evaluate(async () => {
          const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
          const snapshot = await host.getSnapshot();
          await host.saveDashboardConfig({ schemaVersion: 4, name: "Scroll background", root: {
            id: "background", component: "./components/external/core/markdown", props: { content: "Background paragraph.\n\n".repeat(150) },
          } }, snapshot.configRevision!);
          const task = await host.launchAgent({ kind: "component",  nodeIds: ["background"], prompt: "Review this dashboard. " + "Keep the full prompt available. ".repeat(200) });
          await host.appendAgentMessage(task.taskId, Array.from({ length: 120 }, (_, i) => `Activity ${i}`).join("\n\n") + "\n\nLAST ACTIVITY");
          return task.taskId;
        });
        await proof.getByRole("dialog", { name: "Agent work" }).locator(`[data-task-id="${taskId}"]`).click();
        const dialog = proof.getByRole("dialog", { name: "Agent session" });
        const transcript = dialog.getByRole("log", { name: "Agent transcript" });
        await transcript.getByText("LAST ACTIVITY", { exact: true }).waitFor();
        // The content pane, not the document, is the page scroller.
        const background = proof.locator(".app-frame__scroll");
        const backgroundTop = () => background.evaluate((element) => element.scrollTop);
        await background.evaluate((element) => element.scrollTo(0, 400));
        const backgroundPosition = await backgroundTop();
        expect(backgroundPosition).toBe(400);
        expect(await proof.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
        const wheel = async (delta: number) => {
          await proof.mouse.wheel(0, delta);
          await proof.waitForTimeout(150);
          expect(await backgroundTop()).toBe(backgroundPosition);
        };
        await transcript.hover();
        await wheel(1500); // Already at the bottom of the transcript.
        await wheel(-40000);
        expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
        await wheel(-1500); // Remain at the top without moving the dashboard.
        await dialog.getByRole("tab", { name: "Prompt", exact: true }).click();
        const command = dialog.locator(".agent-task-modal__prompt-text");
        await command.hover();
        await wheel(20000);
        expect(await command.evaluate((element) => element.scrollTop > 0)).toBe(true);
        await wheel(1500);
        await wheel(-20000);
        await wheel(-1500);
        expect(await command.evaluate((element) => element.scrollTop)).toBe(0);
        await dialog.getByRole("heading", { name: "Agent session", exact: true }).hover();
        await wheel(1500); // Non-scrollable modal chrome also contains the gesture.
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await proof.getByRole("dialog", { name: "Agent work" }).getByRole("button", { name: "Close", exact: true }).click();
        await proof.locator(".workspace").hover();
        await proof.mouse.wheel(0, 500);
        await proof.waitForFunction((previous) => document.querySelector(".app-frame__scroll")!.scrollTop > previous, backgroundPosition);
        expect(await proof.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
        // Scrolled content never carries the header or sidebar with it.
        expect(await proof.evaluate(() => [".app-header", ".sidebar"].map((selector) => document.querySelector(selector)!.getBoundingClientRect().top))).toEqual([0, 0]);
      } finally { await proof.close(); }
    }
  }, 30_000);

  test("environment panel shows the winning app setting while preserving bundle defaults", async () => {
    const proof = await openPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library", exact: true }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 4, name: "Environment proof", root: { id: "env-proof", component: "./components/external/core/env", props: { path: ".dash-bored/.env" } } }, snapshot.configRevision!);
      });
      const editor = proof.getByRole("region", { name: "Environment editor for .dash-bored/.env", exact: true });
      await editor.locator(".env-editor__effective").getByText("bundle-agent", { exact: true }).waitFor();
      await editor.getByText("Source: Bundle .env", { exact: true }).waitFor();
      expect(await editor.getByRole("textbox", { name: "Variable value for DASH_BORED_AGENT", exact: true }).inputValue()).toBe("bundle-agent");
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.updateAppSettings({ ...await host.getAppSettings(), dashBoredAgent: "fixture-agent --run" });
      });
      await editor.locator(".env-editor__effective").getByText("fixture-agent --run", { exact: true }).waitFor();
      await editor.getByText("Source: Settings", { exact: true }).waitFor();
      expect(await editor.getByRole("textbox", { name: "Variable value for DASH_BORED_AGENT", exact: true }).inputValue()).toBe("bundle-agent");
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.updateAppSettings({ ...await host.getAppSettings(), dashBoredAgent: null });
      });
      await editor.locator(".env-editor__effective").getByText("bundle-agent", { exact: true }).waitFor();
      await editor.getByText("Source: Bundle .env", { exact: true }).waitFor();
    } finally {
      await proof.close();
    }
  }, 20_000);

});

test('themes select personal and dashboard variants, preview/cancel, and preserve mounted terminals', async () => {
  const proof = await openPage({ viewport: { width: 1280, height: 900 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Settings', exact: true }).click();
    await proof.getByRole('tab', { name: 'Themes', exact: true }).click();
    expect(await proof.getByText('Current dashboard', { exact: true }).count()).toBe(0);
    const dashboardAppearance = proof.getByRole('article', { name: 'Appearance settings for Visual verification fixture', exact: true });
    await dashboardAppearance.getByRole('combobox', { name: 'Appearance for Visual verification fixture', exact: true }).selectOption('light');
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    expect(await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).config?.themeMode)).toBe('light');
    await dashboardAppearance.getByRole('combobox', { name: 'Appearance for Visual verification fixture', exact: true }).selectOption('');
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await proof.getByRole('combobox', { name: 'Default theme', exact: true }).selectOption({ label: 'Plum — UI harness · ./themes/plum' });
    await proof.waitForFunction(() => (document.documentElement.dataset.theme ?? '').startsWith('project:'));
    await proof.getByRole('combobox', { name: 'Default theme', exact: true }).selectOption('global:ocean');
    await proof.waitForFunction(() => document.documentElement.dataset.theme === 'global:ocean');
    await proof.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('light');
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    expect(await proof.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#285fbb');
    await proof.screenshot({ path: '/tmp/dash-bored-theme-light.png', fullPage: true });
    await proof.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('system');
    await proof.emulateMedia({ colorScheme: 'dark' });
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await proof.emulateMedia({ colorScheme: 'light' });
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    await proof.emulateMedia({ colorScheme: 'dark' });
    await proof.getByRole('button', { name: 'Visual verification fixture', exact: true }).click();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'UI harness project', root: { id: 'theme-proof', component: './components/external/core/group', children: { axis: 'vertical',
                  first: { node: { id: 'theme-terminal', component: './components/external/core/command', props: { label: 'Theme terminal', command: 'echo theme' } } },
                  second: { axis: 'horizontal', ratio: 0.5,
                      first: { node: { id: 'theme-chart', component: './components/external/core/chart', props: { title: 'Theme chart', labels: ['One', 'Two'], series: [{ label: 'Series', values: [1, 2] }] } } },
                      second: { node: { id: 'theme-markdown', component: './components/external/core/markdown', props: { content: '# Theme preview\n\nReadable text and `code` in both variants.' } } }
                  }
              } } }, snapshot.configRevision!);
      await host.processCommand("theme-terminal", { type: "start" });
    });
    await proof.getByRole('button', { name: 'Open terminal', exact: true }).click();
    await proof.locator('.xterm').waitFor();
    await proof.locator('.xterm').evaluate((element) => { element.setAttribute('data-theme-proof', 'same-terminal'); });
    await proof.emulateMedia({ colorScheme: 'light' });
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    expect(await proof.locator('.xterm').getAttribute('data-theme-proof')).toBe('same-terminal');
    await proof.getByRole('heading', { name: 'Theme preview', exact: true }).waitFor();
    await proof.screenshot({ path: '/tmp/dash-bored-theme-light-dashboard.png', fullPage: true });
    await proof.emulateMedia({ colorScheme: 'dark' });
    await proof.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await proof.getByRole('button', { name: 'Open component library' }).click();
    await proof.getByText('Dashboard appearance', { exact: true }).click();
    await proof.getByRole('combobox', { name: 'Dashboard theme', exact: true }).selectOption('./themes/plum');
    await proof.waitForFunction(() => document.documentElement.dataset.theme === './themes/plum');
    expect(await proof.locator('.xterm').getAttribute('data-theme-proof')).toBe('same-terminal');
    expect(await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).config?.theme)).toBeUndefined();
    await proof.getByRole('button', { name: 'Close Component library', exact: true }).click();
    await proof.getByRole('button', { name: 'Cancel', exact: true }).click();
    await proof.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await proof.waitForFunction(() => document.documentElement.dataset.theme === 'global:ocean');
    expect(await proof.locator('.xterm').getAttribute('data-theme-proof')).toBe('same-terminal');
    await proof.getByRole('button', { name: 'Open component library' }).click();
    const details = proof.locator('.dashboard-appearance');
    if (!await details.getAttribute('open').then((v) => v !== null)) await details.locator('summary').click();
    await proof.getByRole('combobox', { name: 'Dashboard theme', exact: true }).selectOption('./themes/plum');
    await proof.getByRole('button', { name: 'Close Component library', exact: true }).click();
    await proof.getByRole('button', { name: 'Save dashboard', exact: true }).click();
    await proof.waitForFunction(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).config?.theme === './themes/plum');
    await proof.screenshot({ path: '/tmp/dash-bored-theme-dark.png', fullPage: true });
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ ...snapshot.config!, theme: './themes/missing' }, snapshot.configRevision!);
    });
    await proof.waitForFunction(() => document.documentElement.dataset.theme === 'global:ocean');
    await proof.getByText(/Theme unavailable; using a fallback/).waitFor();
    expect(await proof.locator('.xterm').getAttribute('data-theme-proof')).toBe('same-terminal');
    await proof.setViewportSize({ width: 430, height: 850 });
    await proof.screenshot({ path: '/tmp/dash-bored-theme-narrow.png', fullPage: true });
  } finally { await proof.close(); }
}, 30_000);


test('theme package manager runs scoped operations in the app without changing selection', async () => {
  const proof = await openPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Settings', exact: true }).click();
    await proof.getByRole('tab', { name: 'Themes', exact: true }).click();
    await proof.getByRole('region', { name: 'Manage theme packages', exact: true }).waitFor();
    const selection = await proof.getByRole('combobox', { name: 'Default theme', exact: true }).inputValue();
    const run = proof.getByRole('button', { name: 'Run theme operation', exact: true });
    expect(await run.isDisabled()).toBe(true);
    await proof.getByRole('textbox', { name: 'Theme repository URL', exact: true }).fill('https://example.com/ocean.git');
    await proof.getByRole('textbox', { name: 'Theme package name', exact: true }).fill('ocean');
    await proof.getByRole('textbox', { name: 'Theme revision', exact: true }).fill('v2');
    await run.click();
    await proof.getByText('Ran theme add.', { exact: true }).waitFor();
    await proof.getByRole('combobox', { name: 'Theme installation scope' }).selectOption('project');
    const configPath = await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).configPath);
    await proof.getByRole('combobox', { name: 'Theme operation', exact: true }).selectOption('sync');
    await run.click();
    await proof.getByText('Ran theme sync.', { exact: true }).waitFor();
    await proof.getByRole('combobox', { name: 'Theme operation', exact: true }).selectOption('remove');
    expect(await run.isDisabled()).toBe(true);
    await proof.getByRole('textbox', { name: 'Theme package name', exact: true }).fill('ocean');
    await run.click();
    await proof.getByText('Ran theme remove.', { exact: true }).waitFor();
    expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPackageOperations())).toEqual([
      { kind: 'theme', op: 'add', scope: 'global', url: 'https://example.com/ocean.git', name: 'ocean', ref: 'v2' },
      { kind: 'theme', op: 'sync', scope: 'project', configPath },
      { kind: 'theme', op: 'remove', scope: 'project', configPath, name: 'ocean' },
    ]);
    expect(await proof.getByRole('combobox', { name: 'Default theme', exact: true }).inputValue()).toBe(selection);
    await proof.setViewportSize({ width: 430, height: 900 });
    await proof.screenshot({ path: '/tmp/dash-bored-theme-manager.png', fullPage: true });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await proof.close(); }
});

test('updates say up to date plainly and show migrations only when dashboards need them', async () => {
  const proof = await openPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Settings', exact: true }).click();
    await proof.getByRole('tab', { name: 'Updates', exact: true }).click();
    const panel = proof.getByRole('region', { name: 'Updates', exact: true });
    // A single available channel is not a choice worth showing.
    expect(await panel.getByRole('combobox', { name: 'Release channel' }).count()).toBe(0);
    await panel.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await panel.getByRole('heading', { name: "You're up to date" }).waitFor();
    expect(await panel.getByRole('button', { name: 'Check for updates', exact: true }).count()).toBe(1);
    expect(await panel.getByRole('group', { name: /migrating/ }).count()).toBe(0);
    expect(await panel.getByRole('button', { name: /Update/ }).count()).toBe(0);
    await proof.screenshot({ path: '/tmp/dash-bored-updates-current.png', fullPage: true });

    const metadata = { format: 1, product: 'dash-bored', version: '0.3.0', channel: 'canary', platform: 'macos', arch: 'arm64', dashboardContract: 4, minimumContract: 3, recipes: [],
      notes: [
        '# dash-bored v0.3.0', '', 'Unsigned macOS prerelease for **Apple Silicon** on **macOS 14 or newer**.', '',
        '## What\'s new', '', '- Shinier panels.', '- Faster start, even on large dashboards with many live charts and running terminals.', '',
        '## Install', '', '1. Download `dash-bored-v0.3.0-macos-arm64-unsigned.dmg` and `SHA256SUMS.txt`.',
        '2. Optionally verify the download with `shasum -a 256 -c SHA256SUMS.txt`.',
        '3. If blocked, open **System Settings → Privacy & Security**, select **Open Anyway**, and confirm.', '',
        'Save drafts and finish running work before replacing the app. Restart and install uses the verified native updater; the verified DMG fallback preserves normal security approval.',
        '', 'Signing and notarization are deferred.',
      ].join('\n'), updater: { file: 'u', sha256: 'a' }, archive: { file: 'a', sha256: 'a' }, dmg: { file: 'd', sha256: 'a' } };
    const release = { metadata, url: 'https://github.com/example/releases/0.3.0', assetBase: 'https://github.com/example/' };
    const configPath = '/projects/demo/.dash-bored/dash-bored.yaml';
    await proof.evaluate(([release]) => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState({ release, phase: 'available',
      dashboards: [{ configPath: '/projects/other/.dash-bored/dash-bored.yaml', contract: 4, status: 'current', steps: [], message: 'No dashboard migration required.' }] } as never), [release] as const);
    await panel.getByRole('heading', { name: '0.3.0 is here' }).waitFor();
    await panel.getByRole('button', { name: 'Update to 0.3.0', exact: true }).waitFor();
    expect(await panel.getByRole('button', { name: 'Check for updates', exact: true }).isEnabled()).toBe(true);
    // Release notes render as Markdown, without repeating the version title,
    // and keep their text clear of the scrollbar.
    const notes = panel.locator('.updates-panel__notes-body');
    expect(await notes.getByRole('listitem').allTextContents()).toContain('Shinier panels.');
    expect(await notes.locator('strong', { hasText: 'Open Anyway' }).count()).toBeGreaterThan(0);
    expect(await notes.locator('code', { hasText: 'unsigned.dmg' }).count()).toBe(1);
    expect(await notes.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    expect(await notes.innerText()).not.toContain('**');
    expect(await notes.innerText()).not.toContain('dash-bored v0.3.0');
    expect(await notes.evaluate(node => Number.parseFloat(getComputedStyle(node).paddingRight))).toBeGreaterThanOrEqual(12);
    expect(await panel.getByRole('group', { name: /migrating/ }).count()).toBe(0);

    await proof.evaluate(([release, configPath]) => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState({ release, phase: 'available',
      dashboards: [{ configPath, contract: 3, status: 'required', steps: [], message: 'Rename props to settings' }] } as never), [release, configPath] as const);
    const migrate = panel.getByRole('group', { name: '1 dashboard needs migrating' });
    await migrate.waitFor();
    expect(await panel.getByRole('button', { name: 'Update and migrate', exact: true }).isDisabled()).toBe(true);
    await migrate.getByRole('checkbox', { name: /demo/ }).check();
    await panel.getByRole('button', { name: 'Update and migrate 1 dashboard', exact: true }).waitFor();
    expect(await panel.getByRole('button', { name: 'Update without migrating', exact: true }).isEnabled()).toBe(true);
    await proof.screenshot({ path: '/tmp/dash-bored-updates-desktop.png', fullPage: true });
    await proof.setViewportSize({ width: 390, height: 844 });
    await proof.screenshot({ path: '/tmp/dash-bored-updates-narrow.png', fullPage: true });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Checking stays available for a downloaded target and after installation.
    await proof.evaluate(([release]) => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState({
      phase: 'ready', dashboards: [],
      release: { ...release, metadata: { ...release.metadata, version: '0.3.1' } },
      receipt: { format: 1, id: 'ui-update', release, choice: 'update-only', selected: [], migrations: {}, cancelled: false, installation: 'ready' },
    } as never), [release] as const);
    await panel.getByRole('heading', { name: '0.3.0 is downloaded' }).waitFor();
    await panel.getByText('0.3.1 is now available. Cancel this update to download the newer release.').waitFor();
    expect(await panel.getByRole('button', { name: 'Check for updates', exact: true }).isEnabled()).toBe(true);
    await proof.evaluate(([release]) => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState({
      currentVersion: '0.3.0', phase: 'finished', dashboards: [], release, installedThisLaunch: true,
      receipt: { format: 1, id: 'ui-update', release, choice: 'update-only', selected: [], migrations: {}, cancelled: false, installation: 'installed' },
    } as never), [release] as const);
    await panel.getByRole('heading', { name: 'Welcome to 0.3.0' }).waitFor();
    await panel.getByRole('button', { name: 'Check for updates', exact: true }).click();
    expect(await proof.evaluate(async () => Boolean((await window.__DASH_BORED_UI_HARNESS_HOST__!.getUpdateState()).checkedAt))).toBe(true);
    await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState(null));
  } finally { await proof.close(); }
}, 30_000);

test('package updates show pinned packages behind their repository and update them explicitly', async () => {
  const proof = await openPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    const settings = proof.getByRole('button', { name: 'Settings', exact: true });
    await settings.click();
    await proof.getByRole('tab', { name: 'Updates', exact: true }).click();
    const card = proof.getByRole('region', { name: 'Package updates', exact: true });
    await card.getByText('See whether pinned component packages and themes have newer versions.').waitFor();
    expect(await settings.getAttribute('aria-describedby')).toBeNull();
    await card.getByRole('button', { name: 'Check packages', exact: true }).click();
    const behind = card.getByRole('list', { name: 'Packages with updates', exact: true });
    const row = behind.getByRole('listitem').filter({ hasText: 'core' });
    await row.waitFor();
    await card.getByText('1 update available.', { exact: true }).waitFor();
    expect(await row.locator('.package-update__versions').innerText()).toMatch(/v0\.1\.4\+4\s*→\s*v0\.1\.5/);
    expect(await row.getByRole('link', { name: /^Changes in core/ }).getAttribute('href')).toContain('/compare/');
    // The Settings entry and the Updates tab announce what is waiting without renaming them.
    expect(await settings.getAttribute('aria-describedby')).toBe('sidebar-update-count');
    expect(await proof.locator('#sidebar-update-count').textContent()).toBe('1 update available');
    expect(await proof.locator('.settings-tabs__badge').innerText()).toBe('1');
    await card.getByText('1 package up to date', { exact: true }).click();
    await card.getByRole('list', { name: 'Up-to-date packages', exact: true }).getByText('ocean', { exact: true }).waitFor();
    await proof.screenshot({ path: '/tmp/dash-bored-package-updates.png', fullPage: true });

    await row.getByRole('button', { name: /^Update core in / }).click();
    await card.getByText('UI fixture: package update received; no checkout changed.', { exact: true }).waitFor();
    expect(await behind.count()).toBe(0);
    expect(await card.getByText('All 2 pinned packages are up to date.', { exact: true }).count()).toBe(1);
    expect(await proof.locator('.settings-tabs__badge').count()).toBe(0);
    expect(await settings.getAttribute('aria-describedby')).toBeNull();
    expect(await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.getPackageUpdateCommands())).toEqual([
      { type: 'check' }, { type: 'update', ids: ['component:/ui-harness/.dash-bored/dash-bored.yaml:core'] },
    ]);

    // Packages that cannot update say why, and nothing offers to update them.
    await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setPackageUpdates({ checkedAt: new Date().toISOString(), packages: [
      { id: 'component:/p/.dash-bored/dash-bored.yaml:widgets', kind: 'component', name: 'widgets', url: 'https://example.com/widgets.git',
        configPath: '/p/.dash-bored/dash-bored.yaml', dashboardName: 'Other dashboard', current: { commit: 'a'.repeat(40) }, latest: { commit: 'b'.repeat(40) },
        status: 'available', blocked: 'Has local changes. Commit or discard them before updating.' },
      { id: 'theme:personal:sunset', kind: 'theme', name: 'sunset', url: 'https://example.com/sunset.git', configPath: null, dashboardName: null,
        current: { commit: 'c'.repeat(40) }, latest: null, status: 'unknown', error: 'Could not reach https://example.com/sunset.git' },
    ] }));
    await card.getByText('Has local changes. Commit or discard them before updating.', { exact: true }).waitFor();
    expect(await card.getByRole('button', { name: 'Update widgets in Other dashboard', exact: true }).isDisabled()).toBe(true);
    expect(await card.getByText(/^Couldn’t check: Could not reach/).count()).toBe(1);
    expect(await card.getByRole('button', { name: /^Update all/ }).count()).toBe(0);
    expect(await proof.locator('.settings-tabs__badge').count()).toBe(0);
    await proof.setViewportSize({ width: 390, height: 844 });
    await proof.screenshot({ path: '/tmp/dash-bored-package-updates-narrow.png', fullPage: true });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await proof.close(); }
}, 30_000);

test('update palette opens Settings and background lock failures expose recovery', async () => {
  const proof = await openPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: /Open command palette/ }).click();
    const palette = proof.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('Open updates');
    await palette.getByRole('option', { name: /Open updates/ }).click();
    const panel = proof.getByRole('region', { name: 'Updates', exact: true });
    await panel.waitFor();
    expect(await proof.getByRole('tab', { name: 'Updates', exact: true }).getAttribute('aria-selected')).toBe('true');
    await proof.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      host.setUpdateState({ phase: 'available', release: { metadata: { version: '0.5.0', notes: '' } } } as never);
      const original = host.updateAction.bind(host);
      host.updateAction = async (action) => {
        if (action.type === 'prepare') {
          const acknowledged = await host.getUpdateState();
          host.setUpdateState({ ...acknowledged, phase: 'problem', message: 'Another update operation owns the lock. Recover interrupted update after its owner exits.' });
          return acknowledged;
        }
        if (action.type === 'recover') {
          host.setUpdateState({ phase: 'idle', checkedAt: new Date().toISOString(), message: 'Recovered.' });
          return host.getUpdateState();
        }
        return original(action);
      };
    });
    await panel.getByRole('button', { name: 'Update to 0.5.0', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'owns the lock' }).waitFor();
    await panel.getByRole('button', { name: 'Recover interrupted update', exact: true }).waitFor();
    await proof.screenshot({ path: '/tmp/dash-bored-update-lock-recovery.png' });
    await proof.getByRole('button', { name: /Open command palette/ }).click();
    await palette.getByRole('combobox').fill('Recover interrupted update');
    await palette.getByRole('option', { name: /Recover interrupted update/ }).click();
    await panel.getByRole('heading', { name: "You're up to date" }).waitFor();
    await proof.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setUpdateState({ phase: 'downloading', message: 'Preparing verified installation.',
      receipt: { installation: 'awaiting-install', cancelled: false, selected: [], release: { metadata: { version: '0.5.0' } } } } as never));
    await panel.getByRole('heading', { name: 'Preparing installation…' }).waitFor();
    expect(await panel.getByRole('progressbar').count()).toBe(1);
    expect(await panel.getByRole('button', { name: 'Restart and install', exact: true }).count()).toBe(0);
  } finally { await proof.close(); }
}, 30_000);

test('focus timer pauses, resumes, completes and starts breaks explicitly', async () => {
  const proof = await openPage({ viewport: { width: 1100, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Focus studio', root: {
              id: 'focus-proof', component: './components/external/core/focus-timer',
              props: { title: 'Make something worth shipping', focusMinutes: 1, breakMinutes: 1 }
          } }, snapshot.configRevision!);
    });
    const timer = proof.getByRole('region', { name: 'Focus timer', exact: true });
    await timer.getByRole('button', { name: 'Start focus', exact: true }).waitFor();
    await proof.clock.install();
    await timer.getByRole('button', { name: 'Start focus', exact: true }).click();
    await proof.clock.fastForward(10_000);
    await timer.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await timer.getByRole('timer').innerText();
    await proof.clock.fastForward(120_000);
    expect(await timer.getByRole('timer').innerText()).toBe(paused);
    await timer.getByRole('button', { name: 'Resume', exact: true }).click();
    await proof.clock.fastForward(60_000);
    await timer.getByRole('button', { name: 'Start break', exact: true }).waitFor();
    expect(await timer.getByRole('timer').innerText()).toBe('00:00');
    expect(await timer.innerText()).toContain('1 focus sessions completed');
    await proof.clock.fastForward(120_000);
    expect(await timer.getByRole('timer').innerText()).toBe('00:00');
    await timer.getByRole('button', { name: 'Start break', exact: true }).click();
    await proof.clock.fastForward(5_000);
    await timer.getByRole('button', { name: 'Reset', exact: true }).click();
    expect(await timer.getByRole('timer').innerText()).toBe('01:00');
    await timer.getByRole('button', { name: 'Start break', exact: true }).waitFor();
    await proof.screenshot({ path: '/tmp/dash-bored-focus-desktop.png', fullPage: true });
    await proof.setViewportSize({ width: 390, height: 844 });
    expect(await timer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await proof.screenshot({ path: '/tmp/dash-bored-focus-mobile.png', fullPage: true });
  } finally { await proof.close(); }
}, 20_000);

test('action buttons compose persistent tab and sidebar navigation at narrow widths', async () => {
  const proof = await openPage({ viewport: { width: 1440, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Action navigation', root: {
        id: 'shell', component: './components/external/core/group', persistOnFocus: true, children: {
          axis: 'vertical',
          first: { node: {
            id: 'navigation', component: './components/external/core/group', persistOnFocus: true, children: {
              axis: 'horizontal',
              first: { node: { id: 'focus-todo', component: './components/external/core/button', props: { name: 'Focus todos', action: 'focus:todo' } } },
              second: { axis: 'horizontal',
                first: { node: { id: 'focus-local', component: './components/external/core/button', props: { name: 'Focus fixture', action: 'focus:local-action' } } },
                second: { node: { id: 'refresh-local', component: './components/external/core/button', props: { name: 'Refresh fixture', action: 'component:local-action:refresh' } } },
              },
            },
          } },
          second: { axis: 'horizontal',
            first: { node: { id: 'todo', component: './components/external/core/todo-list', props: { todos: [{ description: 'Persistent navigation proof', done: false, tags: ['focus'] }] } } },
            second: { node: { id: 'local-action', component: './components/host-stability' } },
          },
        },
      } }, snapshot.configRevision!);
    });

    const focusTodos = proof.getByRole('button', { name: 'Focus todos', exact: true });
    const focusFixture = proof.getByRole('button', { name: 'Focus fixture', exact: true });
    const refresh = proof.getByRole('button', { name: 'Refresh fixture', exact: true });
    await refresh.waitFor();
    expect(await refresh.isEnabled()).toBe(true);
    await focusTodos.click();
    await proof.waitForFunction(() => document.querySelector<HTMLButtonElement>('.action-button__control[aria-current="page"]')?.textContent?.includes('Focus todos'));
    expect(await focusTodos.getAttribute('aria-current')).toBe('page');
    expect(await refresh.isDisabled()).toBe(true);
    expect(await refresh.getAttribute('title')).toContain('not available');

    await focusFixture.focus();
    await proof.keyboard.press('Enter');
    await refresh.waitFor();
    expect(await refresh.isEnabled()).toBe(true);
    await refresh.click();
    await proof.getByText(/refreshes 1/).waitFor();

    const desktopBoxes = await Promise.all([focusTodos, focusFixture, refresh].map((button) => button.boundingBox()));
    expect(desktopBoxes.every((box) => box !== null)).toBeTrue();
    expect(Math.max(...desktopBoxes.map((box) => box!.y)) - Math.min(...desktopBoxes.map((box) => box!.y))).toBeLessThan(2);
    await proof.screenshot({ path: '/tmp/dash-bored-action-buttons-desktop.png', fullPage: true });

    await proof.setViewportSize({ width: 390, height: 844 });
    await proof.screenshot({ path: '/tmp/dash-bored-action-buttons-narrow.png', fullPage: true });
    const narrowBoxes = await Promise.all([focusTodos, focusFixture, refresh].map((button) => button.boundingBox()));
    expect(narrowBoxes[0]!.y).toBeLessThan(narrowBoxes[1]!.y);
    expect(narrowBoxes[1]!.y).toBeLessThan(narrowBoxes[2]!.y);
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await proof.close(); }
}, 30_000);

test('built-in timer and Markdown actions share button invocation and availability', async () => {
  const proof = await openPage({ viewport: { width: 1440, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Built-in actions', root: {
        id: 'root', component: './components/external/core/group', children: { axis: 'vertical',
          first: { node: { id: 'controls', component: './components/external/core/button', props: { items: [
            { name: 'Remote start', action: 'component:timer:start' },
            { name: 'Remote pause', action: 'component:timer:pause' },
            { name: 'Remote reset', action: 'component:timer:reset' },
            { name: 'Remote edit', action: 'component:markdown:edit' },
            { name: 'Remote preview', action: 'component:markdown:preview' },
          ] } } },
          second: { axis: 'horizontal',
            first: { node: { id: 'timer', component: './components/external/core/focus-timer', props: { focusMinutes: 1, breakMinutes: 1 } } },
            second: { node: { id: 'markdown', component: './components/external/core/markdown', props: { content: 'Original Markdown' } } },
          },
        },
      } }, snapshot.configRevision!);
    });
    const start = proof.getByRole('button', { name: 'Remote start', exact: true });
    const pause = proof.getByRole('button', { name: 'Remote pause', exact: true });
    await start.waitFor();
    expect(await start.isEnabled()).toBe(true);
    expect(await pause.isEnabled()).toBe(false);
    await start.click();
    await proof.waitForFunction(() => document.querySelector('.focus-timer__controls')?.textContent?.includes('Pause'));
    expect(await start.isEnabled()).toBe(false);
    await pause.click();
    await proof.waitForFunction(() => document.querySelector('.focus-timer__controls')?.textContent?.includes('Resume'));
    await proof.getByRole('button', { name: 'Remote reset', exact: true }).click();
    await proof.getByRole('button', { name: 'Start focus', exact: true }).waitFor();
    await proof.getByRole('button', { name: 'Remote edit', exact: true }).click();
    await proof.locator('.markdown-viewer textarea').waitFor();
    await proof.getByRole('button', { name: 'Remote preview', exact: true }).click();
    expect(await proof.locator('.markdown-viewer textarea').count()).toBe(0);
    expect(await proof.getByText('Original Markdown', { exact: true }).count()).toBe(1);
    expect(await proof.getByText('COMPONENT_ACTION_UNDECLARED', { exact: true }).count()).toBe(0);
  } finally { await proof.close(); }
});

test('stable-ID tab and todo actions select locally and change only the draft', async () => {
  const proof = await openPage({ viewport: { width: 1440, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Tab and todo actions', root: {
        id: 'root', component: './components/external/core/group', children: { axis: 'vertical',
          first: { node: { id: 'controls', component: './components/external/core/button', props: { items: [
            { name: 'Choose second tab', action: { run: 'component:tabs:select', with: { child: 'second' } } },
            { name: 'Complete selected todo', action: { run: 'component:second:toggle', with: { id: 'stable-todo' } } },
            { name: 'Remove selected todo', action: { run: 'component:second:remove', with: { id: 'stable-todo' } } },
          ] } } },
          second: { node: { id: 'tabs', component: './components/external/core/tabs', children: [
            { metadata: { label: 'First' }, node: { id: 'first', component: './components/external/core/markdown', props: { content: 'First panel' } } },
            { metadata: { label: 'Second' }, node: { id: 'second', component: './components/external/core/list', props: { todos: [{ id: 'stable-todo', description: 'Selected task', done: false, tags: ['proof'] }] } } },
          ] } },
        },
      } }, snapshot.configRevision!);
    });
    await proof.getByRole('button', { name: /Open command palette/ }).click();
    const selectPalette = proof.getByRole('dialog', { name: 'Command palette' });
    await selectPalette.getByRole('combobox').fill('Select tab');
    await selectPalette.getByRole('option', { name: /Select tab/ }).click();
    await selectPalette.getByRole('option', { name: 'Second', exact: true }).click();
    await proof.getByRole('checkbox', { name: 'Mark complete: Selected task', exact: true }).waitFor();
    await proof.getByRole('tab', { name: 'First', exact: true }).click();
    await proof.getByRole('button', { name: 'Choose second tab', exact: true }).click();
    await proof.getByRole('checkbox', { name: 'Mark complete: Selected task', exact: true }).waitFor();
    await proof.getByRole('button', { name: 'Complete selected todo', exact: true }).click();
    await proof.getByRole('checkbox', { name: 'Mark incomplete: Selected task', exact: true }).waitFor();
    await proof.getByRole('button', { name: 'Save dashboard', exact: true }).waitFor();
    expect(await proof.evaluate(async () => JSON.stringify((await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).config))).toContain('"done":false');
    await proof.getByRole('button', { name: 'Remove selected todo', exact: true }).click();
    const palette = proof.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('heading', { name: 'Remove selected todo from the dashboard draft?' }).waitFor();
    await proof.getByRole('checkbox', { name: 'Mark incomplete: Selected task', exact: true }).waitFor();
    expect(await proof.getByRole('checkbox', { name: 'Mark incomplete: Selected task', exact: true }).count()).toBe(1);
    await proof.keyboard.press('Escape');
    expect(await proof.getByText('COMPONENT_ACTION_UNDECLARED', { exact: true }).count()).toBe(0);
  } finally { await proof.close(); }
});

test('source lists leave todo mutations unavailable while preserving filter actions', async () => {
  const proof = await openPage({ viewport: { width: 1440, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Source list actions', root: {
        id: 'root', component: './components/external/core/group', children: { axis: 'vertical',
          first: { node: { id: 'controls', component: './components/external/core/button', props: { items: [
            { name: 'Toggle source todo', action: { run: 'component:source-list:toggle', with: { id: 'one' } } },
            { name: 'Remove source todo', action: { run: 'component:source-list:remove', with: { id: 'one' } } },
            { name: 'Filter proof tag', action: { run: 'component:source-list:filter', with: { tag: 'proof' } } },
            { name: 'Clear proof filter', action: 'component:source-list:clear-filter' },
          ] } } },
          second: { node: { id: 'source-list', component: './components/external/core/list', props: { source: { inline: [
            { id: 'one', title: 'Tagged item', tags: ['proof'] },
            { id: 'two', title: 'Other item', tags: ['other'] },
          ] } } } },
        },
      } }, snapshot.configRevision!);
    });
    await proof.getByText('Other item', { exact: true }).waitFor();
    for (const name of ['Toggle source todo', 'Remove source todo']) {
      const action = proof.getByRole('button', { name, exact: true });
      expect(await action.isEnabled()).toBe(false);
      expect(await action.getAttribute('title')).toBe('Component is not mounted');
    }
    await proof.getByRole('button', { name: 'Filter proof tag', exact: true }).click();
    await proof.waitForFunction(() => !document.querySelector('.source-list')?.textContent?.includes('Other item'));
    await proof.getByRole('button', { name: 'Clear proof filter', exact: true }).click();
    await proof.getByText('Other item', { exact: true }).waitFor();
    expect(await proof.getByRole('button', { name: 'Save dashboard', exact: true }).count()).toBe(0);
    expect(await proof.getByText('COMPONENT_ACTION_UNDECLARED', { exact: true }).count()).toBe(0);
  } finally { await proof.close(); }
});


test('list states and item process feedback use semantic colors and keep runs with their invoking item', async () => {
  const proof = await openPage({ viewport: { width: 1280, height: 800 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      host.processCommand = async (id, command) => {
        if (command.type !== 'start' && command.type !== 'quick-action') {
          return (await host.getSnapshot()).processes.find(p => p.id === id)!;
        }
        const process = { id, phase: 'running' as const, interactive: true, pid: 42,
          exitCode: null, signal: null, logs: [], run: {
            phase: 'running' as const, exitCode: null, signal: null, startedAt: new Date().toISOString(),
          } };
        host.setProcessSnapshot(process);
        return process;
      };
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'List feedback', root: {
        id: 'root', component: './components/external/core/group', children: { axis: 'vertical',
          first: { node: { id: 'feedback-list', component: './components/external/core/list', props: {
            source: { inline: [
              { id: 'healthy', title: 'Healthy item', state: 'healthy' },
              { id: 'warning', title: 'Warning item', state: 'warning' },
              { id: 'error', title: 'Error item', state: 'error' },
              { id: 'unknown', title: 'Unknown item', state: 'unknown' },
            ] }, itemActions: [{ name: 'Run', action: 'component:feedback-command:run' }],
          } } },
          second: { node: { id: 'feedback-command', component: './components/external/core/command', props: { label: 'Fixture command', command: 'fixture-only' } } },
        },
      } }, snapshot.configRevision!);
    });
    const list = proof.locator('.source-list');
    await list.getByText('Healthy item', { exact: true }).waitFor();
    for (const [id, tone] of [['healthy', 'positive'], ['warning', 'warning'], ['error', 'negative'], ['unknown', 'neutral']] as const) {
      const row = list.locator(`[data-item-id="${id}"]`);
      expect(await row.getAttribute('data-tone')).toBe(tone);
      expect(await row.locator('.source-list__glyph svg').count()).toBe(1);
    }
    const row = list.locator('[data-item-id="healthy"]');
    const feedback = row.locator('.source-list__feedback');
    await row.getByRole('button', { name: 'Run', exact: true }).click();
    await feedback.getByText('Running', { exact: true }).waitFor();
    expect(await row.getByText('Finished', { exact: true }).count()).toBe(0);
    const colors: string[] = [];
    for (const [phase, exitCode, label, tone] of [
      ['running', null, 'Running', 'warning'], ['stopping', null, 'Stopping', 'warning'],
      ['exited', 0, 'Finished', 'positive'], ['exited', 2, 'Failed: exit 2', 'negative'],
    ] as const) {
      await proof.evaluate(async ({ phase, exitCode }) => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const process = (await host.getSnapshot()).processes.find(p => p.id === 'feedback-command')!;
        host.setProcessSnapshot({ ...process, run: { ...process.run!, phase, exitCode } });
      }, { phase, exitCode });
      await feedback.getByText(label, { exact: true }).waitFor();
      expect(await feedback.getAttribute('data-tone')).toBe(tone);
      expect(await feedback.locator('svg').count()).toBe(1);
      colors.push(await feedback.evaluate(e => getComputedStyle(e).color));
    }
    expect(colors[0]).toBe(colors[1]);
    expect(new Set(colors).size).toBe(3);
    await list.locator('[data-item-id="warning"]').getByRole('button', { name: 'Run', exact: true }).click();
    await list.locator('[data-item-id="warning"] .source-list__feedback').getByText('Running', { exact: true }).waitFor();
    expect(await feedback.count()).toBe(0);
  } finally { await proof.close(); }
}, 20_000);

test('visual overview preserves refresh geometry, state shapes, and reduced motion', async () => {
  const proof = await openPage({ viewport: { width: 1280, height: 800 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const reads = new Map<string, number>();
      const finish: Array<() => void> = [];
      (window as Window & { finishVisualReads?: () => void }).finishVisualReads = () => finish.splice(0).forEach(resolve => resolve());
      host.runShell = async (request) => {
        const count = reads.get(request.command) ?? 0;
        reads.set(request.command, count + 1);
        // StrictMode performs two initial effect reads. Hold subsequent refreshes.
        if (count > 1) await new Promise<void>(resolve => finish.push(resolve));
        const value = request.command === 'visual-status' ? { state: 'healthy', detail: 'Current observation' }
          : [{ id: 'one', title: 'Open task', state: 'warning' }];
        return { stdout: JSON.stringify(value), stderr: '', exitCode: 0, signal: null, timedOut: false };
      };
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Visual overview', root: {
        id: 'visual-proof', component: './components/external/core/group', children: { axis: 'vertical',
          first: { node: { id: 'visual-status', component: './components/external/core/status', props: { label: 'Source state', source: { shell: 'visual-status' } } } },
          second: { axis: 'vertical',
            first: { node: { id: 'visual-refresh', component: './components/external/core/button', props: { name: 'Refresh source state', action: 'component:visual-status:refresh' } } },
            second: { node: { id: 'visual-list', component: './components/external/core/list', props: { title: 'Open work', source: { shell: 'visual-list' } } } },
          },
        },
      } }, snapshot.configRevision!);
    });
    await proof.getByText('Current observation', { exact: true }).waitFor();
    await proof.getByText('Open task', { exact: true }).waitFor();
    const status = proof.locator('.status');
    const list = proof.locator('.source-list');
    expect(await status.getAttribute('data-tone')).toBe('positive');
    expect(await status.locator('svg').count()).toBe(1);
    expect(await list.locator('li[data-tone="warning"] svg').count()).toBe(1);
    const before = await Promise.all([status, list].map(view => view.boundingBox()));
    // The button's center stays clickable while its hover drag handle remains visible at the top.
    await proof.getByRole('button', { name: 'Refresh source state', exact: true }).click();
    await status.locator('.status__refreshing').waitFor({ state: 'attached' });
    await list.getByRole('button', { name: 'Refresh', exact: true }).click();
    await proof.waitForFunction(() => document.querySelector('.source-list')?.getAttribute('data-refreshing') === 'true');
    const during = await Promise.all([status, list].map(view => view.boundingBox()));
    expect(during).toEqual(before);
    expect(await status.locator('.status__refreshing').evaluate(e => e.getBoundingClientRect().height)).toBe(1);
    expect(await list.getByText('Updating…', { exact: true }).evaluate(e => e.getBoundingClientRect().height)).toBe(1);
    await proof.evaluate(() => (window as Window & { finishVisualReads?: () => void }).finishVisualReads?.());
    await proof.waitForFunction(() => !document.querySelector('.source-list')?.hasAttribute('data-refreshing'));
    await proof.emulateMedia({ reducedMotion: 'reduce' });
    expect(await status.evaluate(e => parseFloat(getComputedStyle(e).animationDuration))).toBeLessThanOrEqual(0.001);
    await proof.setViewportSize({ width: 390, height: 844 });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await proof.close(); }
}, 20_000);

test('glance atoms show trend, proportion, changes, item reveal, and chart refresh without moving layout', async () => {
  const proof = await openPage({ viewport: { width: 1280, height: 900 } });
  proof.setDefaultTimeout(5_000);
  type GlanceWindow = Window & { glance?: { status: unknown; list: unknown; hold: boolean; release: Array<() => void> } };
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const glance = {
        status: { state: 'healthy', detail: 'Observed', trend: [1, 1, 2, 5, 6], segments: [{ label: 'Done', value: 2, state: 'done' }, { label: 'Open', value: 1, state: 'open' }, { label: 'Bugs', value: 1, state: 'bug' }] },
        list: [{ id: 'a', title: 'Alpha' }, { id: 'missing', title: 'Gone from backlog' }],
        hold: false,
        release: [] as Array<() => void>,
      };
      (window as GlanceWindow).glance = glance;
      host.runShell = async (request) => {
        if (request.command === 'glance-chart' && glance.hold) await new Promise<void>(resolve => glance.release.push(resolve));
        const value = request.command === 'glance-list' ? glance.list
          : request.command === 'glance-chart' ? { labels: ['A', 'B'], series: [{ label: 'Runs', values: [1, 2] }] }
            : glance.status;
        return { stdout: JSON.stringify(value), stderr: '', exitCode: 0, signal: null, timedOut: false };
      };
      const snapshot = await host.getSnapshot();
      const status = (id: string, extra: Record<string, unknown> = {}) => ({ node: { id, component: './components/external/core/status', props: { label: id, source: { shell: 'glance-status' }, ...extra } } });
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Glance proof', root: {
        id: 'glance', component: './components/external/core/group', children: { axis: 'vertical',
          first: { axis: 'horizontal', first: status('glance-tile'), second: status('glance-compact', { density: 'compact' }) },
          second: { axis: 'vertical',
            first: { node: { id: 'glance-refresh', component: './components/external/core/button', props: { name: 'Refresh glance status', action: 'component:glance-tile:refresh' } } },
            second: { axis: 'vertical',
              first: { node: { id: 'glance-list', component: './components/external/core/list', props: { title: 'Attention', sort: 'source-order', filterByTags: false, source: { shell: 'glance-list' },
                itemActions: [{ name: 'Show in backlog', action: { run: 'reveal:glance-backlog', with: { item: '${item.id}' } } }] } } },
              second: { axis: 'vertical',
                first: { node: { id: 'glance-chart', component: './components/external/core/chart', props: { title: 'Runs', type: 'bar', source: { shell: 'glance-chart' } } } },
                second: { node: { id: 'glance-backlog', component: './components/external/core/list', props: { title: 'Backlog', todos: [
                  { id: 'a', description: 'Alpha todo', done: false, tags: [] },
                  { id: 'b', description: 'Beta todo', done: false, tags: [] },
                ] } } },
              },
            },
          },
        },
      } }, snapshot.configRevision!);
    });
    const tile = proof.locator('.status[aria-label^="glance-tile"]');
    const compact = proof.locator('.status--compact');
    await tile.getByText('Observed', { exact: true }).waitFor();
    await compact.getByText('Observed', { exact: true }).waitFor();

    // Trend and proportion carry text beside the marks.
    expect(await tile.getByRole('img').getAttribute('aria-label')).toContain('Trend rising over 5 points');
    await tile.getByText('↗ rising', { exact: true }).waitFor();
    expect(await tile.locator('.glance-meter__legend li').allInnerTexts()).toEqual(['Done 2\n50%', 'Open 1\n25%', 'Bugs 1\n25%']);
    expect(await tile.locator('.glance-meter__legend li[data-tone="negative"] svg').count()).toBe(1);

    // Compact density keeps the label and value on one line and stays shorter.
    const [tileBox, compactBox] = await Promise.all([tile.boundingBox(), compact.boundingBox()]);
    expect(compactBox!.height).toBeLessThan(tileBox!.height);
    const [label, value] = await Promise.all([compact.locator('.status__label').boundingBox(), compact.locator('.status__value').boundingBox()]);
    expect(Math.abs(label!.y - value!.y)).toBeLessThan(4);

    // A changed status value keeps text state and does not change geometry.
    await proof.evaluate(() => { (window as GlanceWindow).glance!.status = { ...(window as GlanceWindow).glance!.status as object, state: 'warning' }; });
    await proof.getByRole('button', { name: 'Refresh glance status', exact: true }).click();
    await tile.locator('.status__changed').waitFor();
    expect(await tile.locator('.status__changed').innerText()).toMatch(/^Changed\s+from healthy · /);
    // The previous state and time wrap under "Changed" instead of being clipped.
    expect(await tile.locator('.status__changed').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTrue();
    expect(await tile.getAttribute('data-changed')).toBe('true');
    expect((await tile.boundingBox())!.height).toBe(tileBox!.height);
    await proof.waitForFunction(() => !document.querySelector('.status[aria-label^="glance-tile"]')?.hasAttribute('data-changed'));
    await tile.locator('.status__changed').waitFor();

    // List items mark what changed in the latest differing observation.
    const list = proof.locator('.source-list');
    expect(await list.locator('[data-change]').count()).toBe(0);
    await proof.evaluate(() => { (window as GlanceWindow).glance!.list = [{ id: 'a', title: 'Alpha edited' }, { id: 'missing', title: 'Gone from backlog' }, { id: 'b', title: 'Beta' }]; });
    await list.getByRole('button', { name: 'Refresh', exact: true }).click();
    await list.locator('li[data-item-id="b"][data-change="new"]').waitFor();
    expect(await list.locator('li[data-item-id="a"]').getAttribute('data-change')).toBe('changed');
    expect(await list.locator('li[data-item-id="missing"]').getAttribute('data-change')).toBeNull();
    await list.locator('li[data-item-id="a"]').getByText('Changed', { exact: true }).waitFor();
    await list.getByText(/3 items · 2 changed at /).waitFor();

    // Drill down: reveal the matching backlog item, focus it, and mark it briefly.
    await list.locator('li[data-item-id="b"]').getByRole('button', { name: 'Show in backlog', exact: true }).click();
    const revealed = proof.locator('.todo [data-item-id="b"]');
    await proof.waitForFunction(() => document.querySelector('.todo [data-item-id="b"]')?.getAttribute('data-revealed') === 'true');
    expect(await revealed.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await proof.locator('.todo [data-revealed]').count()).toBe(1);
    await list.locator('li[data-item-id="missing"]').getByRole('button', { name: 'Show in backlog', exact: true }).click();
    await list.getByText('Item missing is not shown in glance-backlog; it may be filtered out or removed.', { exact: true }).waitFor();

    // Chart refresh shows a visible cue in existing chrome.
    const chart = proof.locator('.chart');
    await chart.locator('.chart__svg').waitFor();
    const chartBefore = await chart.boundingBox();
    await proof.evaluate(() => { (window as GlanceWindow).glance!.hold = true; });
    await chart.getByRole('button', { name: 'Refresh', exact: true }).click();
    await proof.waitForFunction(() => document.querySelector('.chart')?.getAttribute('data-refreshing') === 'true');
    await chart.locator('.chart__heading').getByText('Updating…', { exact: true }).waitFor();
    expect(await chart.boundingBox()).toEqual(chartBefore);
    expect(await chart.locator('.chart__refresh svg').evaluate(e => getComputedStyle(e).animationName)).toBe('chart-refresh-turn');
    await proof.emulateMedia({ reducedMotion: 'reduce' });
    expect(await chart.locator('.chart__refresh svg').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
    await proof.evaluate(() => { const glance = (window as GlanceWindow).glance!; glance.hold = false; glance.release.splice(0).forEach(resolve => resolve()); });
    await proof.waitForFunction(() => !document.querySelector('.chart')?.hasAttribute('data-refreshing'));
    await proof.setViewportSize({ width: 390, height: 844 });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await proof.close(); }
}, 30_000);

test('list items keep a readable title beside many tags and actions in a half-width pane', async () => {
  const proof = await openPage({ viewport: { width: 1280, height: 900 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const list = (id: string) => ({ node: { id, component: './components/external/core/list', props: { title: 'Working tree', sort: 'source-order', source: { inline: [
        { id: 'yaml', title: '.dash-bored/dash-bored.yaml', detail: 'Modified in the working tree', state: 'modified', tags: ['unstaged', '.dash-bored'] },
      ] }, itemActions: [
        { name: 'Diff', action: 'component:narrow-left:refresh' },
        { name: 'Review with agent', action: 'component:narrow-left:refresh' },
      ] } } });
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: 'Narrow list', root: {
        id: 'narrow', component: './components/external/core/group', children: { axis: 'horizontal', first: list('narrow-left'), second: list('narrow-right') },
      } }, snapshot.configRevision!);
    });
    const title = proof.locator('.source-list').first().locator('.source-list__item-text > strong');
    await title.getByText('.dash-bored/dash-bored.yaml', { exact: true }).waitFor();
    for (const width of [1280, 900, 640]) {
      await proof.setViewportSize({ width, height: 900 });
      const geometry = await title.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
        overflows: [...document.querySelectorAll('.source-list__item')].some((item) => item.scrollWidth > item.clientWidth),
      }));
      // The path fits on at most two lines instead of collapsing to a column of single characters.
      expect(geometry.width).toBeGreaterThan(150);
      expect(geometry.lines).toBeLessThanOrEqual(2);
      expect(geometry.overflows).toBe(false);
    }
  } finally { await proof.close(); }
}, 20_000);
