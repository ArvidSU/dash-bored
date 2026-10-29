import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ProcessCommand } from "../../src/shared/contracts";
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
    headless: true, timeout: 15_000,
  });
}, 30_000);

afterAll(async () => {
  try { await browser?.close(); }
  finally { await server?.stop(); }
}, 30_000);

async function openCommandFixture(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5_000);
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
  await page.evaluate(async () => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
    const snapshot = await host.getSnapshot();
    await host.saveDashboardConfig({ schemaVersion: 4, name: "Command run regression", root: {
      id: "root", component: "./components/external/core/group", children: { axis: "vertical",
        first: { node: { id: "command-proof", component: "./components/external/core/command",
          props: { label: "Fixture command", command: "fixture-only" } } },
        second: { axis: "vertical",
          first: { node: { id: "command-status", component: "./components/external/core/status",
            props: { label: "Latest command", source: { process: "command-proof" } } } },
          second: { node: { id: "command-items", component: "./components/external/core/list", props: {
            source: { inline: [{ id: "first", title: "First task" }, { id: "second", title: "Second task" }] },
            itemActions: [{ name: "Run task", action: { run: "component:command-proof:run", with: { id: "${item.id}" } } }],
          } } },
        },
      },
    } }, snapshot.configRevision!);
  });
  await page.getByRole("button", { name: "Run Fixture command", exact: true }).waitFor();
  return page;
}

async function finishRun(page: Page, exitCode: number): Promise<void> {
  await page.evaluate(async (code) => {
    const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
    const process = (await host.getSnapshot()).processes.find((p) => p.id === "command-proof")!;
    if (!process.run || process.run.phase !== "running") throw new Error("Expected an active fixture run.");
    host.setProcessSnapshot({ ...process, run: { ...process.run, phase: "exited", exitCode: code, durationMs: 12 } });
  }, exitCode);
}

test("Run exits and runs again in the same terminal while process status follows the latest run", async () => {
  const page = await openCommandFixture();
  try {
    const command = page.locator(".command");
    await command.getByRole("button", { name: "Open terminal", exact: true }).click();
    await command.getByText("open", { exact: true }).waitFor();
    await page.locator('.status[aria-label="Latest command: unknown"]').getByText("Terminal open; not run yet", { exact: true }).waitFor();
    await command.getByRole("button", { name: "Run Fixture command", exact: true }).click();
    await command.getByText("running", { exact: true }).waitFor();
    expect(await command.getByRole("button", { name: "Running…", exact: true }).isDisabled()).toBe(true);
    await page.locator('.status[aria-label="Latest command: warning"]').getByText("Running", { exact: true }).waitFor();
    const first = await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).processes.find((p) => p.id === "command-proof")!);
    expect(first.run?.phase).toBe("running");
    await finishRun(page, 0);
    await command.getByText("exit 0", { exact: true }).waitFor();
    await page.locator('.status[aria-label="Latest command: healthy"]').getByText("Exit code 0", { exact: true }).waitFor();
    const run = command.getByRole("button", { name: "Run Fixture command", exact: true });
    expect(await run.isEnabled()).toBe(true);
    await run.click();
    await command.getByText("running", { exact: true }).waitFor();
    const second = await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).processes.find((p) => p.id === "command-proof")!);
    expect(second.pid).toBe(first.pid);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.run?.startedAt).not.toBe(first.run?.startedAt);
    expect(second.run?.exitCode).toBeNull();
    await finishRun(page, 2);
    await command.getByText("exit 2", { exact: true }).waitFor();
    await page.locator('.status[aria-label="Latest command: error"]').getByText("Exit code 2", { exact: true }).waitFor();
    expect(await run.isEnabled()).toBe(true);
    await command.getByRole("button", { name: "Close terminal", exact: true }).click();
    await command.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
    await command.getByRole("button", { name: "Open terminal", exact: true }).click();
    await command.getByRole("button", { name: "Close terminal", exact: true }).waitFor();
    // Reopening clears terminal lifetime state; the latest command result
    // stays available until another run, as in ProcessManager.openTerminal.
    await command.getByText("exit 2", { exact: true }).waitFor();
    const reopened = await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getSnapshot()).processes.find((p) => p.id === "command-proof")!);
    expect(reopened.phase).toBe("running");
    expect(reopened.signal).toBeNull();
    expect(reopened.pid).not.toBe(second.pid);
    expect(reopened.run?.startedAt).toBe(second.run?.startedAt);
    expect(await run.isEnabled()).toBe(true);
  } finally { await page.close(); }
}, 20_000);

test("item actions pass typed values to fixture runs and feedback follows the invoking item", async () => {
  const page = await openCommandFixture();
  try {
    await page.evaluate(() => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      const processCommand = host.processCommand.bind(host);
      const commands: ProcessCommand[] = [];
      (window as Window & { commandRequests?: ProcessCommand[] }).commandRequests = commands;
      // Observe requests, retaining the real fixture state transitions.
      host.processCommand = (id, command) => { commands.push(command); return processCommand(id, command); };
    });
    const first = page.locator('.source-list [data-item-id="first"]');
    const second = page.locator('.source-list [data-item-id="second"]');
    await first.getByRole("button", { name: "Run task", exact: true }).click();
    await first.locator(".source-list__feedback").getByText("Running", { exact: true }).waitFor();
    expect(await second.getByRole("button", { name: "Run task", exact: true }).isDisabled()).toBe(true);
    await finishRun(page, 0);
    await first.locator(".source-list__feedback").getByText("Finished", { exact: true }).waitFor();
    await second.getByRole("button", { name: "Run task", exact: true }).click();
    await second.locator(".source-list__feedback").getByText("Running", { exact: true }).waitFor();
    expect(await first.locator(".source-list__feedback").count()).toBe(0);
    await finishRun(page, 2);
    await second.locator(".source-list__feedback").getByText("Failed: exit 2", { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as Window & { commandRequests?: ProcessCommand[] }).commandRequests?.filter((command) => command.type === "start")))
      .toEqual([{ type: "start", itemEnvironment: { DASH_ITEM_ID: "first" } }, { type: "start", itemEnvironment: { DASH_ITEM_ID: "second" } }]);
  } finally { await page.close(); }
}, 20_000);
