import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ComponentNode, ComponentChildLayout } from "../../src/shared/contracts";

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

async function addGroupDraft(): Promise<void> {
  const active = currentPage();
  await active.getByRole("button", { name: "Open component library" }).click();
  await active.getByRole("button", { name: "Insert Group", exact: true }).click();
  await active.getByRole("heading", { name: "Add component" }).waitFor();
  await active.getByRole("button", { name: "Add component", exact: true }).click();
  await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
  await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
}

async function persistedGroupCount(): Promise<number> {
  return await currentPage().evaluate(async () => {
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
      return (node.component === "@dash-bored/group" && node.id !== "group" ? 1 : 0) + nested;
    };
    return config ? visit(config.root) : 0;
  });
}

async function persistedTodoDone(): Promise<boolean | undefined> {
  return await currentPage().evaluate(async () => {
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

  test("palette choice steps keep headings and full-width options inside the dialog", async () => {
    const active = currentPage();
    const originalViewport = active.viewportSize();
    for (const width of [1280, 390]) {
      await active.setViewportSize({ width, height: 844 });
      await active.getByRole("button", { name: /Open command palette/ }).click();
      const palette = active.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Set default theme");
      await palette.getByRole("option", { name: /Set default theme/ }).click();
      const heading = palette.getByRole("heading", { name: "Select default theme" });
      await heading.waitFor();
      const group = palette.getByRole("group", { name: "Select default theme" });
      const bounds = await palette.boundingBox();
      const title = await heading.boundingBox();
      const list = await group.boundingBox();
      const option = await group.getByRole("button").first().boundingBox();
      expect(bounds && title && list && option).toBeTruthy();
      expect(title!.x + title!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(list!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
      expect(Math.abs(option!.width - list!.width)).toBeLessThan(1);
      expect(await palette.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      // Use real keyboard events without focusing a locator: entering a step
      // must establish focus itself, including when the previous button unmounts.
      const options = group.getByRole("button");
      const isFocused = (index: number) => options.nth(index).evaluate(
        (element) => element === document.activeElement,
      );
      expect(await isFocused(0)).toBe(true);
      await active.keyboard.press("ArrowDown");
      expect(await isFocused(1)).toBe(true);
      await active.keyboard.press("ArrowUp");
      expect(await isFocused(0)).toBe(true);
      await active.keyboard.press("ArrowUp");
      expect(await isFocused(await options.count() - 1)).toBe(true);
      await active.keyboard.press("ArrowDown");
      expect(await isFocused(0)).toBe(true);
      await active.keyboard.press("ArrowDown");
      await active.keyboard.press("Enter");
      await palette.getByRole("heading", { name: "Select default appearance" }).waitFor();
      await active.keyboard.press("Escape");
      await heading.waitFor();
      await active.keyboard.press("Escape");
      await palette.getByRole("combobox").waitFor();
      await active.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
    }
    if (originalViewport) await active.setViewportSize(originalViewport);
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

    const agentInput = settings.getByRole("textbox", { name: "DASH_BORED_AGENT" });
    expect(await settings.getByRole("button", { name: "Clear app-wide DASH_BORED_AGENT setting", exact: true }).count()).toBe(0);
    await agentInput.fill("");
    await settings.locator(".settings-agent").getByRole("button", { name: "Save", exact: true }).click();
    await active.getByRole("status").getByText("App-wide DASH_BORED_AGENT cleared; the project .env will be used when available.", { exact: true }).waitFor();
    await active.waitForFunction(() => (document.querySelector<HTMLInputElement>("#dash-bored-agent")?.value ?? "") === "");
    expect(await agentInput.inputValue()).toBe("");
    await agentInput.fill("codex exec");
    await settings.locator(".settings-agent").getByRole("button", { name: "Save", exact: true }).click();
    expect(await agentInput.inputValue()).toBe("codex exec");

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
    await palette.getByRole("combobox").fill("reload app");
    expect(await palette.getByText("Favorites", { exact: true }).count()).toBe(1);
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

  test("agent work keeps a dashboard-only request visible after dispatch", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open agent work" }).click();
    const activity = active.getByRole("dialog", { name: "Agent work" });
    await activity.waitFor();
    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.runComponentAgent({ nodeId: "status", prompt: "Show a clearer fixture state." });
    });
    const task = activity.locator(".agent-task").first();
    await task.waitFor();
    expect(await task.getByText("Show a clearer fixture state.", { exact: true }).count()).toBe(1);
    expect(await task.locator("time").count()).toBe(1);
    await task.click();
    const command = active.getByRole("dialog", { name: "Agent command" });
    await command.locator(".command__terminal .xterm").waitFor();
    expect(await command.getByRole("tab").count()).toBe(3);
    expect(await command.getByRole("tab", { name: "Terminal", exact: true }).getAttribute("aria-selected")).toBe("true");
    await command.getByRole("tab", { name: "Diff", exact: true }).click();
    await command.locator(".agent-task-modal__diff").getByText("diff --git", { exact: false }).waitFor();
    expect(await command.locator(".agent-task-modal__diff").getByText(".dash-bored/dash-bored.yaml", { exact: false }).count()).toBe(1);
    await command.getByRole("tab", { name: "Command", exact: true }).click();
    expect(await command.locator(".agent-task-modal__command").getByText("codex exec 'Show a clearer fixture state.'", { exact: true }).count()).toBe(1);
    await command.getByRole("button", { name: "Copy command", exact: true }).click();
    await command.getByRole("button", { name: "Copied", exact: true }).waitFor();
    await command.getByRole("tab", { name: "Terminal", exact: true }).click();
    await command.locator(".command__terminal .xterm").waitFor();
    expect(await command.getByRole("button", { name: "Close terminal", exact: true }).count()).toBe(1);
    await command.getByRole("button", { name: "Close terminal", exact: true }).click();
    await task.getByText("Not working", { exact: true }).waitFor();
    expect(await command.locator(".command__terminal .xterm").count()).toBe(1);
    await command.getByRole("button", { name: "Close", exact: true }).click();

    await task.click();
    const completedCommand = active.getByRole("dialog", { name: "Agent command" });
    await completedCommand.locator(".command__terminal .xterm").waitFor();
    expect(await completedCommand.getByRole("button", { name: "Close terminal", exact: true }).count()).toBe(0);
    await completedCommand.getByRole("button", { name: "Close", exact: true }).click();
    await activity.getByRole("button", { name: "Close", exact: true }).click();
    expect(await activity.count()).toBe(0);
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
    const command = active.getByRole("dialog", { name: "Agent command" });
    await command.locator(".agent-task-modal__request").getByText("Fix dashboard configuration diagnostics.", { exact: true }).waitFor();
    expect(await command.getByText("/ui-harness/.dash-bored/dash-bored.yaml#diagnostics", { exact: true }).count()).toBe(1);
    await command.getByRole("button", { name: "Close terminal", exact: true }).click();
    await task.getByText("Not working", { exact: true }).waitFor();
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
      return (await host.getDashboardAgentTasks()).length;
    });
    await repair.click();
    await active.getByRole("status").getByText("Moved the old installed tools to Trash and installed the current dash-bored tools.", { exact: true }).waitFor();
    expect(await diagnostics.count()).toBe(0);
    expect(await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return (await host.getDashboardAgentTasks()).length;
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
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await persistedGroupCount()).toBe(0);
  }, 20_000);

  test("only the deepest hovered component reveals its menu", async () => {
    const active = currentPage();
    const card = active.locator('[data-node-id="renderer-proof-card"]');
    const status = active.locator('[data-node-id="renderer-proof-status"]');
    const cardMenu = card.locator(":scope > .component-node__menu");
    const statusMenu = status.locator(":scope > .component-node__menu");
    const statusBox = await status.boundingBox();
    const cardHeaderBox = await card.locator("header").first().boundingBox();
    if (!statusBox || !cardHeaderBox) throw new Error("Nested menu geometry is unavailable.");

    await active.mouse.move(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
    await active.waitForTimeout(250);
    expect(await statusMenu.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await statusMenu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    expect(await cardMenu.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    expect(await cardMenu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    await active.mouse.move(cardHeaderBox.x + cardHeaderBox.width / 2, cardHeaderBox.y + cardHeaderBox.height / 2);
    await active.waitForTimeout(250);
    expect(await cardMenu.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await cardMenu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    expect(await statusMenu.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  });

  test("a left click outside the library closes it without beginning a draft", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();

    await active.getByText("Revision 1", { exact: true }).click({ position: { x: 4, y: 4 } });

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
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
  }, 20_000);

  test("structural mutation starts a draft, save persists, and cancel restores", async () => {
    expect(await persistedGroupCount()).toBe(0);
    await addGroupDraft();

    expect(await persistedGroupCount()).toBe(0);
    await currentPage().getByRole("button", { name: "Save dashboard" }).click();
    await currentPage().getByText("Revision 2", { exact: true }).waitFor();
    expect(await persistedGroupCount()).toBe(1);

    await addGroupDraft();
    await currentPage().getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await currentPage().getByRole("button", { name: "Discard changes", exact: true }).click();
    await currentPage().getByRole("button", { name: "Open component library" }).waitFor();
    expect(await persistedGroupCount()).toBe(1);
  }, 20_000);

  test("an incompatible pointer drop does not mutate the draft or persisted fixture", async () => {
    const active = currentPage();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Group", exact: true });
    // The app header is outside the managed component tree, so it exposes no pointer insertion boundary.
    const target = active.locator(".app-header");
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.mouse.down();
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
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(100);
    await active.mouse.down();
    await active.waitForTimeout(100);
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 8, { steps: 12 });
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

  test("only the deepest hovered component reveals its generated handle", async () => {
    const active = currentPage();
    const card = active.locator('[data-node-id="renderer-proof-card"]');
    const status = active.locator('[data-node-id="renderer-proof-status"]');
    const cardHandle = card.locator(":scope > [data-composition-drag-handle]");
    const statusHandle = status.locator(":scope > [data-composition-drag-handle]");
    const statusBox = await status.boundingBox();
    const cardHeaderBox = await card.locator("header").first().boundingBox();
    if (!statusBox || !cardHeaderBox) throw new Error("Nested handle geometry is unavailable.");

    await active.mouse.move(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
    await active.waitForTimeout(250);
    expect(await statusHandle.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await statusHandle.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    expect(await cardHandle.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    expect(await cardHandle.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    await active.mouse.move(cardHeaderBox.x + cardHeaderBox.width / 2, cardHeaderBox.y + cardHeaderBox.height / 2);
    await active.waitForTimeout(250);
    expect(await cardHandle.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await statusHandle.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  });

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
    await active.getByText("Revision 3", { exact: true }).waitFor();
    expect(await active.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      return JSON.stringify(host.getPersistedConfig());
    })).not.toBe(beforeMove);
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
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).waitFor();
  }, 20_000);

  test("pointer and keyboard insertions both enter the same draft-and-save boundary", async () => {
    const active = currentPage();
    await active.getByRole("tab", { name: "Wide layout", exact: true }).click();
    await active.getByRole("button", { name: "Open component library" }).click();
    const source = active.getByRole("button", { name: "Insert Group", exact: true });
    const target = active.locator('[data-node-id="renderer-proof-card"]');
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Fixture drag geometry is unavailable.");

    await active.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await active.waitForTimeout(100);
    await active.mouse.down();
    await active.waitForTimeout(100);
    await active.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await active.waitForTimeout(150);
    await active.mouse.up();

    await active.getByRole("heading", { name: "Add component" }).waitFor();
    await active.getByRole("button", { name: "Add component", exact: true }).press("Enter");
    await active.getByRole("region", { name: "Dashboard editor" }).waitFor();
    await active.getByRole("dialog", { name: "Component library" }).waitFor();
    expect(await active.getByRole("button", { name: "Save dashboard" }).count()).toBe(1);
    expect(await active.getByRole("button", { name: "Cancel", exact: true }).count()).toBeGreaterThan(0);
    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard" }).click();
    await active.getByText("Revision 4", { exact: true }).waitFor();
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

  test("lazy-loads the interactive command renderer only when it is inserted", async () => {
    const active = currentPage();
    await active.getByRole("region", { name: "Dashboard editor" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await active.getByRole("dialog", { name: "Discard dashboard changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
    const commandModuleRequested = async (): Promise<boolean> => active.evaluate(() =>
      performance.getEntriesByType("resource").some((entry) =>
        entry.name.includes("builtins/command") || entry.name.includes("/assets/command-"),
      ));

    const commandModuleWasInitiallyRequested = await commandModuleRequested();
    if (!commandModuleWasInitiallyRequested) expect(await commandModuleRequested()).toBe(false);
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Command", exact: true }).click();

    const dialog = active.getByRole("dialog", { name: "Add component" });
    await dialog.waitFor();
    await dialog.getByLabel(/^command/i).fill("printf fixture");
    await dialog.getByRole("button", { name: "Add component", exact: true }).click();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await active.getByText("Revision 6", { exact: true }).waitFor();
    await active.waitForTimeout(500);
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
      await host.openProcessTerminal("terminal-stream");
    });

    await active.waitForTimeout(100);
    expect(await effectRuns.textContent()).toBe(beforeProcessUpdate);
  }, 20_000);

  test("lazy-loads the Markdown renderer only when it is inserted", async () => {
    const active = currentPage();
    const markdownModuleRequested = async (): Promise<boolean> => active.evaluate(() =>
      performance.getEntriesByType("resource").some((entry) =>
        entry.name.includes("builtins/markdown") || entry.name.includes("/assets/markdown-"),
      ));

    expect(await markdownModuleRequested()).toBe(false);
    await active.getByRole("button", { name: "Open component library" }).click();
    await active.getByRole("button", { name: "Insert Markdown", exact: true }).click();

    const dialog = active.getByRole("dialog", { name: "Add component" });
    await dialog.waitFor();
    await dialog.getByLabel(/^content/i).fill("## Deferred Markdown\n\nLoaded on demand.");
    await dialog.getByRole("button", { name: "Add component", exact: true }).click();

    await active.getByRole("dialog", { name: "Component library" }).getByRole("button", { name: "Close Component library", exact: true }).click();
    await active.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await active.getByText("Revision 7", { exact: true }).waitFor();
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
    await active.getByText("Revision 8", { exact: true }).waitFor();

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

  test("the legacy starter command remains active when Agent work closes", async () => {
    const active = currentPage();
    await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.runProcessQuickAction("setup-dashboard-with-agent");
    });
    const activity = active.getByRole("dialog", { name: "Agent work" });
    await activity.waitFor();
    const task = activity.locator(".agent-task").first();
    await task.waitFor();
    await task.click();
    const command = active.getByRole("dialog", { name: "Agent command" });
    await command.locator(".command__terminal .xterm").waitFor();

    await command.getByRole("button", { name: "Close", exact: true }).click();
    await activity.getByRole("button", { name: "Close", exact: true }).click();
    await active.getByRole("button", { name: "Open agent work", exact: true }).waitFor();

    const activeProcess = await active.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__;
      if (!host) throw new Error("UI harness host is unavailable.");
      await host.writeProcessTerminal("setup-dashboard-with-agent", "still running\n");
      return (await host.getSnapshot()).processes.find((process) => process.id === "setup-dashboard-with-agent");
    });
    expect(activeProcess?.phase).toBe("running");
    expect(await active.getByRole("button", { name: "Open agent work", exact: true }).count()).toBe(1);

    await active.getByRole("button", { name: "Open agent work", exact: true }).click();
    const reopenedActivity = active.getByRole("dialog", { name: "Agent work" });
    const reopenedTask = reopenedActivity.locator(".agent-task").first();
    await reopenedTask.click();
    const reopenedCommand = active.getByRole("dialog", { name: "Agent command" });
    await reopenedCommand.locator(".command__terminal .xterm").waitFor();
    expect(await reopenedCommand.getByRole("button", { name: "Close terminal", exact: true }).count()).toBe(1);
    await reopenedCommand.getByRole("button", { name: "Close terminal", exact: true }).click();
    await reopenedTask.getByText("Not working", { exact: true }).waitFor();
    await reopenedCommand.getByRole("button", { name: "Close", exact: true }).click();
    await reopenedActivity.getByRole("button", { name: "Close", exact: true }).click();
  }, 20_000);
  test("setup agent inserts lazily, survives starter replacement, and shows validation truthfully", async () => {
    const proof = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library" }).waitFor();
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
      await setup.getByText("Runs codex exec", { exact: true }).waitFor();
      await setup.getByText("Command source: App settings", { exact: true }).waitFor();
      const bounds = await setup.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(390);
      await setup.getByRole("button", { name: "Set up this dashboard", exact: true }).click();
      const activity = proof.getByRole("dialog", { name: "Agent work" });
      const row = activity.locator(".agent-task").first();
      await row.waitFor();
      expect(await row.getByText("Dashboard validated", { exact: true }).count()).toBe(0);
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 3, name: "Configured project", root: { id: "ready", component: "@dash-bored/status", props: { label: "Project ready", state: "healthy" } } }, snapshot.configRevision!);
      });
      expect(await proof.locator(".setup-agent").count()).toBe(0);
      await row.getByText("Working", { exact: true }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.finishAgentTask((await host.getDashboardAgentTasks())[0]!.id, { status: "trust-required", diagnostics: [], message: "Review newly requested permissions." });
      });
      await row.getByText("Review project trust", { exact: true }).waitFor();
      expect(await row.getByText("Dashboard validated", { exact: true }).count()).toBe(0);
      await row.click();
      const details = proof.getByRole("dialog", { name: "Agent command" });
      await details.getByText("Review newly requested permissions.", { exact: true }).waitFor();
      await details.getByText("Recent agent output", { exact: true }).click();
      await details.locator("details .agent-task-modal__diff").getByText("Created project workflows and checked the dashboard.", { exact: true }).waitFor();
      await proof.screenshot({ path: "/tmp/dash-bored-setup-proof.png", fullPage: true });
    } finally {
      await proof.close();
    }
  }, 30_000);

  test("environment panel shows the winning app setting while preserving bundle defaults", async () => {
    const proof = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    proof.setDefaultTimeout(5_000);
    try {
      await proof.goto(fixtureUrl);
      await proof.getByRole("button", { name: "Open component library" }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        const snapshot = await host.getSnapshot();
        await host.saveDashboardConfig({ schemaVersion: 3, name: "Environment proof", root: { id: "env-proof", component: "@dash-bored/env", props: { path: ".dash-bored/.env" } } }, snapshot.configRevision!);
      });
      const editor = proof.getByRole("region", { name: "Environment editor for .dash-bored/.env", exact: true });
      await editor.locator(".env-editor__effective").getByText("codex exec", { exact: true }).waitFor();
      await editor.getByText("Source: Settings", { exact: true }).waitFor();
      expect(await editor.getByRole("textbox", { name: "Variable value for DASH_BORED_AGENT", exact: true }).inputValue()).toBe("bundle-agent");
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.updateAppSettings({ ...await host.getAppSettings(), dashBoredAgent: "fixture-agent --run" });
      });
      await editor.locator(".env-editor__effective").getByText("fixture-agent --run", { exact: true }).waitFor();
      expect(await editor.getByRole("textbox", { name: "Variable value for DASH_BORED_AGENT", exact: true }).inputValue()).toBe("bundle-agent");
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.updateAppSettings({ ...await host.getAppSettings(), dashBoredAgent: null });
      });
      await editor.locator(".env-editor__effective").getByText("bundle-agent", { exact: true }).waitFor();
      await editor.getByText("Source: Bundle .env", { exact: true }).waitFor();
      await proof.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        await host.updateAppSettings({ ...await host.getAppSettings(), dashBoredAgent: "codex exec" });
      });
    } finally {
      await proof.close();
    }
  }, 20_000);

});

test('themes select personal and dashboard variants, preview/cancel, and preserve mounted terminals', async () => {
  const proof = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
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
      await host.saveDashboardConfig({ schemaVersion: 3, name: 'UI harness project', root: { id: 'theme-proof', component: '@dash-bored/group', children: { axis: 'vertical',
                  first: { node: { id: 'theme-terminal', component: '@dash-bored/command', props: { label: 'Theme terminal', command: 'echo theme' } } },
                  second: { axis: 'horizontal', ratio: 0.5,
                      first: { node: { id: 'theme-chart', component: '@dash-bored/chart', props: { title: 'Theme chart', labels: ['One', 'Two'], series: [{ label: 'Series', values: [1, 2] }] } } },
                      second: { node: { id: 'theme-markdown', component: '@dash-bored/markdown', props: { content: '# Theme preview\n\nReadable text and `code` in both variants.' } } }
                  }
              } } }, snapshot.configRevision!);
      await host.startProcess('theme-terminal');
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


test('theme package manager generates scoped commands without changing selection', async () => {
  const proof = await browser!.newPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Settings', exact: true }).click();
    await proof.getByRole('tab', { name: 'Themes', exact: true }).click();
    await proof.getByRole('region', { name: 'Manage theme packages', exact: true }).waitFor();
    const selection = await proof.getByRole('combobox', { name: 'Default theme', exact: true }).inputValue();
    expect(await proof.getByRole('button', { name: 'Copy theme command', exact: true }).isDisabled()).toBe(true);
    await proof.getByRole('textbox', { name: 'Theme repository URL', exact: true }).fill('https://example.com/ocean.git');
    await proof.getByRole('textbox', { name: 'Theme package name', exact: true }).fill('ocean');
    await proof.getByRole('textbox', { name: 'Theme revision', exact: true }).fill("feature/ocean's-colors");
    expect(await proof.getByLabel('Theme command', { exact: true }).textContent()).toContain(`'feature/ocean'"'"'s-colors'`);
    await proof.getByRole('textbox', { name: 'Theme revision', exact: true }).fill('v2');
    expect(await proof.getByLabel('Theme command', { exact: true }).textContent()).toBe("dash-bored theme add 'https://example.com/ocean.git' --name 'ocean' --ref 'v2' --global");
    await proof.getByRole('combobox', { name: 'Theme installation scope' }).selectOption('project');
    const configPath = await proof.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).configPath);
    expect(await proof.getByLabel('Theme command', { exact: true }).textContent()).toContain(configPath!);
    await proof.getByRole('combobox', { name: 'Theme operation', exact: true }).selectOption('sync');
    expect(await proof.getByLabel('Theme command', { exact: true }).textContent()).toBe(`dash-bored theme sync '${configPath}'`);
    await proof.getByRole('combobox', { name: 'Theme operation', exact: true }).selectOption('remove');
    expect(await proof.getByRole('button', { name: 'Copy theme command', exact: true }).isDisabled()).toBe(true);
    await proof.getByRole('textbox', { name: 'Theme package name', exact: true }).fill('ocean');
    expect(await proof.getByLabel('Theme command', { exact: true }).textContent()).toBe(`dash-bored theme remove 'ocean' '${configPath}'`);
    expect(await proof.getByRole('combobox', { name: 'Default theme', exact: true }).inputValue()).toBe(selection);
    await proof.setViewportSize({ width: 430, height: 900 });
    await proof.screenshot({ path: '/tmp/dash-bored-theme-manager.png', fullPage: true });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await proof.close(); }
});

test('updates stay reachable from Settings and expose available channels at desktop and narrow widths', async () => {
  const proof = await browser!.newPage({ viewport: { width: 1100, height: 900 } });
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Settings', exact: true }).click();
    await proof.getByRole('tab', { name: 'Updates', exact: true }).click();
    expect(await proof.getByRole('button', { name: 'Updates and migrations', exact: true }).count()).toBe(0);
    await proof.getByRole('combobox', { name: 'Release channel' }).waitFor();
    expect(await proof.getByRole('combobox', { name: 'Release channel' }).inputValue()).toBe('canary');
    expect(await proof.locator('option[value="beta"]').evaluate(el => (el as HTMLOptionElement).disabled)).toBe(true);
    expect(await proof.locator('option[value="stable"]').evaluate(el => (el as HTMLOptionElement).disabled)).toBe(true);
    await proof.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await proof.getByText('UI fixture: update action received; no installation performed.').waitFor();
    await proof.screenshot({ path: '/tmp/dash-bored-updates-desktop.png', fullPage: true });
    await proof.setViewportSize({ width: 390, height: 844 });
    await proof.screenshot({ path: '/tmp/dash-bored-updates-narrow.png', fullPage: true });
    expect(await proof.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await proof.close(); }
}, 30_000);

test('focus timer pauses, resumes, completes and starts breaks explicitly', async () => {
  const proof = await browser!.newPage({ viewport: { width: 1100, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 3, name: 'Focus studio', root: {
              id: 'focus-proof', component: '@dash-bored/focus-timer',
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
  const proof = await browser!.newPage({ viewport: { width: 1440, height: 850 } });
  proof.setDefaultTimeout(5_000);
  try {
    await proof.goto(fixtureUrl);
    await proof.getByRole('button', { name: 'Open component library' }).waitFor();
    await proof.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 3, name: 'Action navigation', root: {
        id: 'shell', component: '@dash-bored/group', persistOnFocus: true, children: {
          axis: 'vertical',
          first: { node: {
            id: 'navigation', component: '@dash-bored/group', persistOnFocus: true, children: {
              axis: 'horizontal',
              first: { node: { id: 'focus-todo', component: '@dash-bored/button', props: { name: 'Focus todos', action: 'focus:todo' } } },
              second: { axis: 'horizontal',
                first: { node: { id: 'focus-local', component: '@dash-bored/button', props: { name: 'Focus fixture', action: 'focus:local-action' } } },
                second: { node: { id: 'refresh-local', component: '@dash-bored/button', props: { name: 'Refresh fixture', action: 'component:local-action:refresh' } } },
              },
            },
          } },
          second: { axis: 'horizontal',
            first: { node: { id: 'todo', component: '@dash-bored/todo-list', props: { todos: [{ description: 'Persistent navigation proof', done: false, tags: ['focus'] }] } } },
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
