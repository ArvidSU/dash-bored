import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";

let fixtureProcess: ReturnType<typeof Bun.spawn> | null = null;
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

async function waitForFixture(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Renderer fixture did not start at ${url}.`);
}

function currentPage(): Page {
  if (!page) throw new Error("Renderer interaction page is unavailable.");
  return page;
}

async function addTextDraft(content: string): Promise<void> {
  const active = currentPage();
  await active.getByRole("button", { name: "Open component library" }).click();
  await active.getByRole("button", { name: "Insert Text", exact: true }).click();
  await active.getByRole("heading", { name: "Add component" }).waitFor();
  const contentField = active.getByLabel(/content/i);
  await contentField.click();
  await active.keyboard.type(content);
  await active.getByRole("button", { name: "Add component", exact: true }).click();
  await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
  await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
}

async function persistedTextCount(): Promise<number> {
  return await currentPage().evaluate(async () => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__;
    if (!host) throw new Error("UI harness host is unavailable.");
    const config = await host.getSnapshot().then((snapshot) => snapshot.config);
    const visit = (node: { component: string; children?: unknown }): number => {
      const children = node.children as {
        type?: string;
        items?: Array<{ node: typeof node }>;
        layout?: { type?: string; child?: { node: typeof node }; first?: unknown; second?: unknown };
      } | undefined;
      if (!children) return node.component === "@dash-bored/text" ? 1 : 0;
      const nested = children.type === "managed"
        ? (children.items ?? []).reduce((sum, edge) => sum + visit(edge.node), 0)
        : children.type === "tiled" && children.layout
          ? (function visitLayout(layout: typeof children.layout): number {
              if (layout.type === "child" && layout.child) return visit(layout.child.node);
              return (layout.first ? visitLayout(layout.first as typeof layout) : 0)
                + (layout.second ? visitLayout(layout.second as typeof layout) : 0);
            })(children.layout)
          : 0;
      return (node.component === "@dash-bored/text" ? 1 : 0) + nested;
    };
    return config ? visit(config.root) : 0;
  });
}

beforeAll(async () => {
  const executablePath = process.env.DASH_BORED_BROWSER_EXECUTABLE
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(executablePath);
  const port = await unusedPort();
  fixtureUrl = `http://127.0.0.1:${port}/ui-harness.html`;
  fixtureProcess = Bun.spawn({
    cmd: ["bun", "./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    cwd: process.cwd(),
    env: { ...process.env, DASH_BORED_VITE_PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitForFixture(fixtureUrl);
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Open component library" }).waitFor();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (fixtureProcess) {
    fixtureProcess.kill();
    await fixtureProcess.exited;
  }
});

describe("renderer fixture interactions", () => {
  test("opening and cleanly closing the library does not begin a draft", async () => {
    const active = currentPage();
    expect(await persistedTextCount()).toBe(0);
    await active.getByRole("button", { name: "Open component library" }).click();
    expect(await active.locator(".composition-frame-controls").count()).toBe(0);
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await active.getByRole("button", { name: "Save dashboard" }).count()).toBe(0);
    expect(await persistedTextCount()).toBe(0);
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
      "dash-bored:component-heights:/ui-harness/dash-bored/dash-bored.yaml",
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
    await active.getByRole("heading", { name: "Configure component" }).waitFor();
    await active.getByRole("dialog", { name: "Configure component" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await persistedTextCount()).toBe(0);
  }, 20_000);

  test("a left click outside the library closes it without beginning a draft", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();

    await active.getByText("Revision 1", { exact: true }).click({ position: { x: 4, y: 4 } });

    await active.getByRole("button", { name: "Open component library" }).waitFor();
    expect(await active.getByRole("region", { name: "Dashboard editor" }).count()).toBe(0);
    expect(await persistedTextCount()).toBe(0);
  }, 20_000);

  test("cancelling component insertion returns to the component library", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Text", exact: true }).click();
    await active.getByRole("heading", { name: "Add component" }).waitFor();
    await active.getByRole("dialog", { name: "Add component" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
  }, 20_000);

  test("structural mutation starts a draft, save persists, and cancel restores", async () => {
    expect(await persistedTextCount()).toBe(0);
    await addTextDraft("saved through keyboard input");

    expect(await persistedTextCount()).toBe(0);
    await currentPage().getByRole("button", { name: "Save dashboard" }).click();
    await currentPage().getByText("Revision 2", { exact: true }).waitFor();
    expect(await persistedTextCount()).toBe(1);

    await addTextDraft("cancelled draft");
    await currentPage().getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await currentPage().getByRole("button", { name: "Discard changes", exact: true }).click();
    await currentPage().getByRole("button", { name: "Open component library" }).waitFor();
    expect(await persistedTextCount()).toBe(1);
  }, 20_000);

  test("an incompatible pointer drop does not mutate the draft or persisted fixture", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Text", exact: true });
    // The dashboard root already has children, so it exposes no pointer insertion boundary.
    const target = active.locator('[data-node-id="harness-root"]');
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 });
    await active.waitForTimeout(150);
    await active.mouse.up();

    const library = active.getByRole("dialog", { name: "Component library" });
    await library.waitFor();
    expect(await active.getByRole("heading", { name: "Add component" }).count()).toBe(0);
    expect(await active.locator(".component-node--drop-ready").count()).toBe(0);
    expect(await active.getByRole("button", { name: "Insert Text", exact: true }).getAttribute("aria-grabbed")).toBe("false");
    expect(await persistedTextCount()).toBe(1);
    await library.getByRole("button", { name: "Close Component library", exact: true }).click();
  }, 20_000);

  test("dragging advertises one compatible insertion edge inside the hovered card", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Text", exact: true });
    const target = active.locator('[data-node-id="renderer-proof-card"]');
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 8, { steps: 4 });
    const indicator = target.locator(":scope > .composition-drop-indicator--bottom");
    await indicator.waitFor();
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

  test("a component header supports pointer moves without opening the library first", async () => {
    const active = currentPage();
    const beforeMove = await active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    });
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click({ force: true });
    const source = active.locator('[data-node-id="renderer-proof-card"]');
    const target = active.locator('[data-node-id="responsive-card"]');
    const dragHeader = source.locator("header").first();
    const targetBox = await target.boundingBox();
    const headerBox = await dragHeader.boundingBox();
    if (!targetBox || !headerBox) throw new Error("Move header geometry is unavailable.");

    await active.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
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
    await active.getByText("Revision 3", { exact: true }).waitFor();
    expect(await active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    })).not.toBe(beforeMove);
  }, 20_000);

  test("dragging a component header to the removal surface opens confirmation", async () => {
    const active = currentPage();
    const source = active.locator('[data-node-id="renderer-proof-card"]');
    const dragHeader = source.locator("header").first();
    await dragHeader.scrollIntoViewIfNeeded();
    const headerBox = await dragHeader.boundingBox();
    if (!headerBox) throw new Error("Removal header geometry is unavailable.");

    await active.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(headerBox.x + 48, headerBox.y + 12, { steps: 3 });
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
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("pointer and keyboard insertions both enter the same draft-and-save boundary", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Text", exact: true });
    const target = active.locator('[data-node-id="renderer-proof-card"]');
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 });
    await active.waitForTimeout(150);
    await active.mouse.up();

    await active.getByRole("heading", { name: "Add component" }).waitFor();
    await active.getByLabel(/content/i).fill("pointer planner outcome");
    await active.getByRole("button", { name: "Add component", exact: true }).click();
    await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    expect(await active.getByRole("button", { name: "Save dashboard" }).count()).toBe(1);
    expect(await active.getByRole("button", { name: "Cancel", exact: true }).count()).toBeGreaterThan(0);
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard" }).click();
    await active.getByText("Revision 4", { exact: true }).waitFor();
    expect(await persistedTextCount()).toBe(2);
  }, 20_000);

  test("confirmed component removal reopens the component library", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();

    const card = active.locator('[data-node-id="renderer-proof-card"]');
    const dragHeader = card.locator("header").first();
    await dragHeader.scrollIntoViewIfNeeded();
    const headerBox = await dragHeader.boundingBox();
    if (!headerBox) throw new Error("Removal header geometry is unavailable.");
    await active.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
    await active.mouse.down();
    await active.mouse.move(headerBox.x + 48, headerBox.y + 12, { steps: 3 });
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
    await addTextDraft("conflicting draft");
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
    expect(await persistedTextCount()).toBe(2);
  }, 20_000);
});
