import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

/*
 * Agent work against the UI fixture's seeded ACP sessions: one working with a
 * plan, one waiting on a permission, one idle with hand-off available, one
 * waiting for sign-in, and one failed launch (src/renderer/lib/ui-harness-agents.ts).
 */

/** The header trigger's name starts with its action and then counts sessions. */
const OPEN_AGENT_WORK = /^Open agent work\b/;

let fixtureServer: FixtureServer | null = null;
let browser: Browser | null = null;
let fixtureUrl = "";

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new Error("Could not reserve a renderer fixture port.");
  return port;
}

async function openFixture(viewport = { width: 1280, height: 800 }): Promise<Page> {
  const page = await browser!.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
  return page;
}

async function openSession(page: Page, taskId: string) {
  const trigger = page.getByRole("button", { name: OPEN_AGENT_WORK });
  if (await trigger.count()) await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Agent work" });
  await drawer.locator(`[data-task-id="${taskId}"]`).click();
  const session = page.getByRole("dialog", { name: "Agent session" });
  await session.waitFor();
  return { drawer, row: drawer.locator(`[data-task-id="${taskId}"]`), session };
}

function taskCommands(page: Page, taskId: string) {
  return page.evaluate((taskId) => window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTaskCommands()
    .filter((entry) => entry.taskId === taskId)
    .map((entry) => entry.command), taskId);
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
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await fixtureServer?.stop();
}, 30_000);

describe("agent work", () => {
  test("palette chooses a bundle template, collects its variables, and waits for explicit Send", async () => {
    const page = await openFixture();
    try {
      const before = await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTasks()).length);
      await page.keyboard.press("Meta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Send prompt to agent");
      const action = palette.getByRole("option").filter({ has: page.locator("strong").filter({ hasText: /^Send prompt to agent$/ }) });
      await action.waitFor();
      await action.click();
      const choices = palette.getByRole("listbox", { name: "Prompt template", exact: true });
      await choices.waitFor();
      await choices.getByRole("option", { name: /triage-item/ }).click();
      const composer = page.getByRole("dialog", { name: "Ask the agent" });
      await composer.waitFor();
      await composer.getByRole("textbox", { name: "id", exact: true }).fill("todo-42");
      await composer.getByRole("tab", { name: "Full prompt", exact: true }).click();
      await composer.getByLabel("Full agent prompt").getByText("Triage backlog item `todo-42`.", { exact: false }).waitFor();
      expect(await composer.locator('input[type="radio"][value="triage-item"]').isChecked()).toBeTrue();
      expect(await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTasks()).length)).toBe(before);
      await composer.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAgentTasks()).length)).toBe(before);
    } finally { await page.close(); }
  }, 20_000);

  test("a late template catalog for an old focus cannot replace the current target's choices", async () => {
    const page = await openFixture();
    try {
      await page.evaluate(() => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        host.getPromptTemplates = async (nodeId) => nodeId === "responsive-card"
          ? new Promise((resolve) => { (window as unknown as { finishOldCatalog: () => void }).finishOldCatalog = () => resolve([{ name: "old-focus", description: "Old focus", scope: "project", input: "required", builtin: false, vars: null }]); })
          : [{ name: "current-focus", description: "Current focus", scope: "project", input: "required", builtin: false, vars: null }];
      });
      await page.locator('[data-node-id="responsive-card"] header').first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Focus component", exact: true }).click();
      await page.waitForFunction(() => typeof (window as unknown as { finishOldCatalog?: () => void }).finishOldCatalog === "function");
      await page.keyboard.press("Meta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Send prompt to agent");
      expect(await palette.getByRole("option").filter({ has: page.locator("strong").filter({ hasText: /^Send prompt to agent$/ }) }).getAttribute("aria-disabled")).toBe("true");
      await palette.getByRole("combobox").fill("whole dashboard");
      await palette.getByRole("option", { name: /^Show whole dashboard/ }).click();
      await page.evaluate(() => (window as unknown as { finishOldCatalog: () => void }).finishOldCatalog());
      await page.keyboard.press("Meta+k");
      await palette.getByRole("combobox").fill("Send prompt to agent");
      await palette.getByRole("option").filter({ has: page.locator("strong").filter({ hasText: /^Send prompt to agent$/ }) }).click();
      const choices = palette.getByRole("listbox", { name: "Prompt template", exact: true });
      await choices.getByRole("option", { name: /current-focus/ }).waitFor();
      expect(await choices.getByRole("option", { name: /old-focus/ }).count()).toBe(0);
    } finally { await page.close(); }
  }, 20_000);
  test("drawer rows show each session's state with color, shape, and text, and the badge counts sessions that need watching", async () => {
    const page = await openFixture();
    try {
      const trigger = page.getByRole("button", { name: OPEN_AGENT_WORK });
      const badge = trigger.locator(".agent-activity-trigger__count");
      expect(await badge.textContent()).toBe("3");
      expect(await badge.getAttribute("data-waiting")).toBe("true");
      // The badge is visual; the name says the same.
      expect(await trigger.getAttribute("aria-label")).toBe("Open agent work, 3 active, 2 need you");
      await trigger.click();
      const drawer = page.getByRole("dialog", { name: "Agent work" });
      const expected = [
        ["fixture-working", "Working", "Claude Code"],
        ["fixture-waiting", "Needs permission", "Codex"],
        ["fixture-idle", "Idle", "Gemini CLI"],
        ["fixture-auth", "Sign-in required", "GitHub Copilot CLI"],
        ["fixture-failed", "Failed", "my-acp-agent"],
      ] as const;
      for (const [taskId, state, agent] of expected) {
        const row = drawer.locator(`[data-task-id="${taskId}"]`);
        const chip = row.locator(".agent-chip[data-state]");
        expect(await chip.textContent()).toBe(state);
        expect(await chip.locator("svg").count()).toBe(1);
        expect(await row.locator(".agent-task__agent").textContent()).toBe(agent);
        expect(await row.locator("time").count()).toBe(1);
        expect((await row.getAttribute("aria-label"))?.startsWith(`${state}: `)).toBe(true);
      }
      expect(await drawer.locator('[data-task-id="fixture-idle"]').getAttribute("aria-label")).toMatch(/\. Dashboard validated$/);
      // Newest first, as the host orders them.
      expect(await drawer.locator(".agent-task").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-task-id"))))
        .toEqual(expected.map(([taskId]) => taskId));
      expect(await drawer.locator('[data-task-id="fixture-idle"]').getByText("Dashboard validated", { exact: true }).count()).toBe(1);
      // Shapes differ by state, not only color.
      const shapes = await drawer.locator(".agent-chip[data-state] svg").evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
      expect(new Set(shapes).size).toBe(5);

      const workingGlyph = drawer.locator('[data-task-id="fixture-working"] .agent-chip[data-state] svg');
      expect(await workingGlyph.evaluate((icon) => getComputedStyle(icon).animationName)).toBe("agent-glyph-spin");
      expect(await drawer.locator('[data-task-id="fixture-idle"] .agent-chip[data-state] svg').evaluate((icon) => getComputedStyle(icon).animationName)).toBe("none");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await workingGlyph.evaluate((icon) => getComputedStyle(icon).animationName)).toBe("none");
    } finally { await page.close(); }
  }, 20_000);

  test("a session that starts waiting reopens a dismissed drawer; other updates do not", async () => {
    const page = await openFixture();
    try {
      const drawer = page.getByRole("dialog", { name: "Agent work" });
      await page.getByRole("button", { name: OPEN_AGENT_WORK }).click();
      await drawer.waitFor();
      await drawer.getByRole("button", { name: "Close", exact: true }).click();
      await drawer.waitFor({ state: "detached" });

      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.appendAgentMessage("fixture-working", " and the status script"));
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.patchAgentTask("fixture-working", { state: "idle" }));
      await page.waitForTimeout(250);
      expect(await drawer.count()).toBe(0);

      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.requestAgentPermission("fixture-idle"));
      await drawer.waitFor();
      await drawer.locator('[data-task-id="fixture-idle"]').getByText("Needs permission", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: /^Close agent work\b/ }).locator(".agent-activity-trigger__count").textContent()).toBe("3");
    } finally { await page.close(); }
  }, 20_000);

  test("permission requests are answered from keyboard-reachable options or dismissed as cancelled", async () => {
    const page = await openFixture();
    try {
      const { row, session } = await openSession(page, "fixture-waiting");
      const card = session.getByRole("group", { name: "Run bun test tests/release/checklist.test.ts" });
      await card.waitFor();
      expect(await card.getByText("Permission needed", { exact: true }).count()).toBe(1);
      expect(await card.locator(".agent-tool__kind").textContent()).toBe("Run");
      expect(await card.getByText("tests/release/checklist.test.ts", { exact: true }).count()).toBe(1);
      expect(await card.getByRole("button").allTextContents()).toEqual(["Allow once", "Always allow", "Reject", "Dismiss"]);
      expect(await card.getByRole("button", { name: "Allow once" }).getAttribute("class")).toContain("button--primary");
      expect(await card.getByRole("button", { name: "Reject" }).getAttribute("class")).toContain("agent-permission__option--reject");
      // The follow-up composer waits for the answer.
      expect(await session.getByRole("textbox", { name: "Follow-up message" }).isDisabled()).toBe(true);

      // A card that just appeared ignores input briefly; then its options take focus.
      await card.getByRole("button", { name: "Always allow" }).click({ trial: true });
      await card.getByRole("button", { name: "Always allow" }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await card.getByRole("button", { name: "Allow once" }).evaluate((button) => button === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await card.waitFor({ state: "detached" });
      expect(await taskCommands(page, "fixture-waiting")).toEqual([
        { type: "permission", requestId: "perm-fixture-1", optionId: "approved" },
      ]);
      await row.getByText("Idle", { exact: true }).waitFor();
      const tool = session.locator(".agent-tool").filter({ hasText: "bun test tests/release/checklist.test.ts" });
      expect(await tool.locator(".agent-tool-status").textContent()).toBe("Done");
      await tool.getByText("Output", { exact: true }).click();
      await tool.getByText("1 pass", { exact: false }).waitFor();

      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.requestAgentPermission("fixture-waiting", { id: "perm-fixture-2", title: "Edit tests/release/checklist.test.ts" }));
      const second = session.getByRole("group", { name: "Edit tests/release/checklist.test.ts" });
      await second.getByRole("button", { name: "Dismiss", exact: true }).click();
      await second.waitFor({ state: "detached" });
      expect((await taskCommands(page, "fixture-waiting")).at(-1)).toEqual({ type: "permission", requestId: "perm-fixture-2", optionId: null });
      await session.getByText("Permission request dismissed; the turn was cancelled.", { exact: true }).waitFor();
      await row.getByText("Idle", { exact: true }).waitFor();
    } finally { await page.close(); }
  }, 20_000);

  test("a double-click answers only the request it landed on; a queued request shows disabled, then takes its own answer", async () => {
    const page = await openFixture();
    try {
      // The host answers first and pushes 50 ms later, and a second request waits behind the first.
      await page.evaluate(() => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        host.setAgentCommandLatency({ pushMs: 50 });
        return host.requestAgentPermission("fixture-waiting", { id: "perm-queued", title: "Edit tests/release/checklist.test.ts" });
      });
      const { session } = await openSession(page, "fixture-waiting");
      const first = session.getByRole("group", { name: "Run bun test tests/release/checklist.test.ts" });
      const allowFirst = first.getByRole("button", { name: "Allow once", exact: true });
      await allowFirst.click({ trial: true });
      await page.evaluate(() => {
        const record = window as unknown as { queuedCardDisabled?: boolean };
        const observer = new MutationObserver(() => {
          const card = document.querySelector('[data-request-id="perm-queued"]');
          if (!card) return;
          record.queuedCardDisabled = [...card.querySelectorAll("button")].every((button) => button.disabled);
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });

      await allowFirst.dblclick();
      const second = session.getByRole("group", { name: "Edit tests/release/checklist.test.ts" });
      await second.waitFor();
      expect(await page.evaluate(() => (window as unknown as { queuedCardDisabled?: boolean }).queuedCardDisabled)).toBe(true);
      // Focus was on the answered card, so the new request's heading takes it.
      expect(await second.getByRole("heading").evaluate((heading) => heading === document.activeElement)).toBe(true);
      await second.getByRole("button", { name: "Allow once", exact: true }).click({ trial: true });
      await page.waitForTimeout(100);
      expect(await taskCommands(page, "fixture-waiting")).toEqual([
        { type: "permission", requestId: "perm-fixture-1", optionId: "approved" },
      ]);

      await second.getByRole("button", { name: "Allow once", exact: true }).click();
      await second.waitFor({ state: "detached" });
      expect((await taskCommands(page, "fixture-waiting")).at(-1)).toEqual({ type: "permission", requestId: "perm-queued", optionId: "allow" });
      // The answered card took its focused button along; focus stays in the session.
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Agent transcript");
    } finally { await page.close(); }
  }, 20_000);

  test("controls stay disabled while a command is pending and show its answer before the push arrives", async () => {
    const page = await openFixture();
    try {
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setAgentCommandLatency({ responseMs: 250, pushMs: 600 }));
      const { row, session } = await openSession(page, "fixture-working");
      const stopStates = page.evaluate(() => new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const started = performance.now();
        const sample = (): void => {
          const stop = [...document.querySelectorAll<HTMLButtonElement>(".agent-task-modal__actions button")]
            .find((button) => button.textContent?.startsWith("Stop"));
          const state = stop ? `${stop.textContent} ${stop.disabled ? "disabled" : "enabled"}` : "gone";
          if (seen.at(-1) !== state) seen.push(state);
          if (performance.now() - started < 900) requestAnimationFrame(sample);
          else resolve(seen);
        };
        sample();
      }));
      await session.getByRole("button", { name: "Stop", exact: true }).click();
      expect(await session.getByRole("button", { name: "Close session", exact: true }).isDisabled()).toBe(true);
      expect(await session.getByRole("combobox", { name: "Model" }).isDisabled()).toBe(true);
      // Stop never enables again between the answer (250 ms) and the push (600 ms).
      expect(await stopStates).toEqual(["Stop enabled", "Stopping… disabled", "gone"]);
      await row.getByText("Idle", { exact: true }).waitFor();
      expect(await session.getByRole("button", { name: "Close session", exact: true }).isDisabled()).toBe(false);
    } finally { await page.close(); }
  }, 20_000);

  test("a follow-up draft survives tab switches and closing the modal, and focus returns after the turn when the push trails the answer", async () => {
    const page = await openFixture();
    try {
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setAgentCommandLatency({ pushMs: 50 }));
      const { row, session } = await openSession(page, "fixture-idle");
      const followUp = session.getByRole("textbox", { name: "Follow-up message" });
      await followUp.fill("Keep this draft");
      await session.getByRole("tab", { name: "Prompt", exact: true }).click();
      await session.getByRole("tab", { name: "Session", exact: true }).click();
      expect(await followUp.inputValue()).toBe("Keep this draft");
      await page.keyboard.press("Escape");
      await session.waitFor({ state: "detached" });
      await openSession(page, "fixture-idle");
      expect(await followUp.inputValue()).toBe("Keep this draft");

      await followUp.focus();
      // Let deferred modal autofocus run before sending; it must respect the
      // field the user focused, including just after reopening the dialog.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await followUp.evaluate((field) => field === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await session.getByRole("log", { name: "Agent transcript" }).getByText("Done. I handled the follow-up: Keep this draft", { exact: true }).waitFor();
      await row.getByText("Idle", { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Follow-up message");
      expect(await followUp.inputValue()).toBe("");
    } finally { await page.close(); }
  }, 20_000);

  test("a new permission request is announced politely and takes focus inside the session modal", async () => {
    const page = await openFixture();
    try {
      const { session } = await openSession(page, "fixture-idle");
      const announcer = session.locator('.visually-hidden[role="status"]');
      expect(await announcer.textContent()).toBe("");
      await session.getByRole("textbox", { name: "Follow-up message" }).focus();
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.requestAgentPermission("fixture-idle", { id: "perm-new", title: "Edit .dash-bored/dash-bored.yaml" }));
      const card = session.getByRole("group", { name: "Edit .dash-bored/dash-bored.yaml" });
      await card.waitFor();
      expect(await announcer.getAttribute("aria-live")).toBe("polite");
      expect(await announcer.textContent()).toBe("Gemini CLI needs permission: Edit .dash-bored/dash-bored.yaml");
      await page.waitForFunction(() => document.activeElement?.matches('[data-request-id="perm-new"] h3') === true);
      // A card shown again with its tab leaves focus on the tab.
      const sessionTab = session.getByRole("tab", { name: "Session", exact: true });
      await session.getByRole("tab", { name: "Prompt", exact: true }).click();
      await sessionTab.click();
      await card.waitFor();
      expect(await sessionTab.evaluate((tab) => tab === document.activeElement)).toBe(true);
    } finally { await page.close(); }
  }, 20_000);

  test("a working session shows its plan, transcript, and session options, and Stop cancels the turn", async () => {
    const page = await openFixture();
    try {
      const { row, session } = await openSession(page, "fixture-working");
      const plan = session.locator(".agent-plan");
      expect(await plan.locator("summary").textContent()).toContain("1 of 3 done");
      expect(await plan.locator(".agent-plan__entry").evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-status"))))
        .toEqual(["completed", "in_progress", "pending"]);
      const transcript = session.getByRole("log", { name: "Agent transcript" });
      // Thoughts stay folded and quiet; Markdown renders a safe subset.
      expect(await transcript.locator("details.agent-entry--thought").getAttribute("open")).toBeNull();
      expect(await transcript.locator("strong").filter({ hasText: "deploy status" }).count()).toBe(1);
      expect(await transcript.locator("ol > li").count()).toBe(3);
      expect(await transcript.locator("pre.markdown-lite__code").textContent()).toBe("git describe --tags --abbrev=0");
      // Edits are summarized as touched paths with line counts, never diffs.
      const edits = await transcript.locator(".agent-tool__paths li").allTextContents();
      expect(edits).toContain(".dash-bored/scripts/deploy-status.sh +9 −0");
      expect(edits).toContain(".dash-bored/dash-bored.yaml +14 −2");
      expect(await transcript.locator(".agent-tool-status").allTextContents()).toEqual(["Done", "Done", "Running"]);

      const model = session.getByRole("combobox", { name: "Model" });
      expect(await model.inputValue()).toBe("sonnet");
      expect(await model.locator("option").allTextContents()).toEqual(["Default (recommended)", "Sonnet", "Opus", "Haiku"]);
      expect(await model.locator("optgroup").getAttribute("label")).toBe("Claude");
      await model.selectOption("opus");
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".agent-config select")?.value === "opus");
      const thinking = session.getByRole("checkbox", { name: "Extended thinking" });
      expect(await thinking.isChecked()).toBe(true);
      await thinking.uncheck();
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".agent-config--boolean input")?.checked === false);
      expect(await taskCommands(page, "fixture-working")).toEqual([
        { type: "config", configId: "model", value: "opus" },
        { type: "config", configId: "thinking", value: false },
      ]);

      // No hand-off while the agent works.
      expect(await session.getByRole("button", { name: /^Resume in/ }).count()).toBe(0);
      await session.getByRole("button", { name: "Stop", exact: true }).click();
      await row.getByText("Idle", { exact: true }).waitFor();
      expect((await taskCommands(page, "fixture-working")).at(-1)).toEqual({ type: "cancel" });
      await transcript.getByText("You stopped the turn.", { exact: true }).waitFor();
      expect(await session.getByRole("button", { name: "Stop", exact: true }).count()).toBe(0);
      // A cancelled first turn completes nothing, so there is no session to resume yet.
      expect(await session.getByRole("button", { name: /^Resume in/ }).count()).toBe(0);
    } finally { await page.close(); }
  }, 20_000);

  test("an idle session hands off to the agent's own app, with a copyable resume command", async () => {
    const page = await openFixture();
    try {
      const { row, session } = await openSession(page, "fixture-idle");
      const transcript = session.getByRole("log", { name: "Agent transcript" });
      // Links stay text plus their URL, raw HTML stays literal, and tables stay monospace.
      expect(await transcript.locator("a").count()).toBe(0);
      expect(await transcript.locator(".markdown-lite__link").textContent()).toBe("the list docs (https://example.com/docs/list)");
      expect(await transcript.locator("b").count()).toBe(0);
      expect(await transcript.textContent()).toContain("<b>Raw HTML stays text.</b>");
      expect(await transcript.locator("pre.markdown-lite__table").textContent()).toContain("| Keep this surface mounted | open |");

      await session.getByRole("button", { name: "Show resume command", exact: true }).click();
      const popover = session.getByRole("group", { name: "Resume command" });
      expect(await popover.locator("code").textContent()).toBe("gemini --resume '4f6c1d2e-gemini-session'");
      expect(await popover.locator(".agent-handoff__hint").textContent()).toBe("dash-bored closes its session when you resume in Gemini CLI.");
      // While the agent works the command and its copy action are not offered.
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.patchAgentTask("fixture-idle", { state: "working" }));
      await popover.waitFor({ state: "detached" });
      expect(await session.getByRole("button", { name: "Show resume command", exact: true }).count()).toBe(0);
      expect(await session.getByRole("button", { name: "Resume in Gemini CLI", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.patchAgentTask("fixture-idle", { state: "idle" }));
      expect(await popover.count()).toBe(0);
      await session.getByRole("button", { name: "Show resume command", exact: true }).click();
      await popover.getByRole("button", { name: "Copy command", exact: true }).click();
      await popover.getByRole("button", { name: "Copied", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
      expect(await session.count()).toBe(1);

      await session.getByRole("button", { name: "Resume in Gemini CLI", exact: true }).click();
      await row.getByText("Closed", { exact: true }).waitFor();
      expect((await taskCommands(page, "fixture-idle")).at(-1)).toEqual({ type: "handoff" });
      await row.getByText("Continued in Gemini CLI", { exact: true }).waitFor();
      expect(await row.getAttribute("aria-label")).toMatch(/\. Continued in Gemini CLI$/);
      await session.getByRole("status").getByText("Continued in Gemini CLI. dash-bored no longer drives this session.", { exact: true }).waitFor();
      expect(await session.getByRole("button", { name: "Close session", exact: true }).count()).toBe(0);
      expect(await session.getByRole("textbox", { name: "Follow-up message" }).count()).toBe(0);
    } finally { await page.close(); }
  }, 20_000);

  test("sign-in runs the agent's own method, and a failed launch shows its error and log tail", async () => {
    const page = await openFixture();
    try {
      const { row, session } = await openSession(page, "fixture-auth");
      const signIn = session.getByRole("region", { name: "Sign in to GitHub Copilot CLI" });
      await signIn.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
      expect(await taskCommands(page, "fixture-auth")).toEqual([{ type: "authenticate", methodId: "github-oauth" }]);
      await row.getByText("Idle", { exact: true }).waitFor();
      await session.getByRole("log", { name: "Agent transcript" }).getByText("Signed in. Reading the dashboard… I added the pull request list.", { exact: true }).waitFor();
      await session.getByRole("button", { name: "Close", exact: true }).click();

      const failed = await openSession(page, "fixture-failed");
      const alert = failed.session.getByRole("alert");
      await alert.getByText("The agent did not answer ACP initialize within 60 seconds.", { exact: false }).waitFor();
      expect(await alert.getByText("Agent log · last 7 lines", { exact: true }).count()).toBe(1);
      expect(await alert.locator(".agent-failure__log").textContent()).toContain("hint: run with --acp to speak the Agent Client Protocol");
      expect(await failed.session.getByRole("group", { name: "Session controls" }).count()).toBe(0);
      expect(await failed.session.getByRole("textbox", { name: "Follow-up message" }).count()).toBe(0);
      await failed.session.getByRole("tab", { name: "Prompt", exact: true }).click();
      expect(await failed.session.locator(".agent-task-modal__launch").textContent()).toBe("my-acp-agent --stdio");
    } finally { await page.close(); }
  }, 20_000);

  test("the composer lists enabled agents and links to Settings when no agent exists", async () => {
    const page = await openFixture();
    try {
      const openComposer = async () => {
        await page.locator('[data-node-id="responsive-card"] header').first().click({ button: "right" });
        await page.getByRole("menuitem", { name: "Change with agent…", exact: true }).click();
        const composer = page.getByRole("dialog", { name: "Ask the agent" });
        await composer.waitFor();
        return composer;
      };
      let composer = await openComposer();
      const agentSelect = composer.getByRole("combobox", { name: "Agent", exact: true });
      await composer.locator(".agent-prompt__runner code").getByText("bundle-agent", { exact: true }).waitFor();
      expect(await agentSelect.locator("option").allTextContents())
        .toEqual(["App default (not set)", "Project .env", "Claude Code", "Codex", "Gemini CLI", "Custom command"]);
      expect(await agentSelect.locator('option[value="app"]').isDisabled()).toBe(true);
      expect(await agentSelect.locator("optgroup").getAttribute("label")).toBe("Enabled agents");
      await agentSelect.selectOption("detected:claude");
      await composer.locator(".agent-prompt__runner code").getByText("claude-agent-acp", { exact: true }).waitFor();
      expect(await composer.getByRole("button", { name: "Enable or set up agents in Settings ↗", exact: true }).count()).toBe(1);
      await composer.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.evaluate(async () => {
        const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
        host.setDetectedAgents([]);
        await host.writeTextFile({ nodeId: "status", path: ".dash-bored/.env", content: "" });
      });
      composer = await openComposer();
      await composer.getByRole("status").getByText("No ACP agent is configured or enabled.", { exact: false }).waitFor();
      expect(await composer.getByRole("combobox", { name: "Agent", exact: true }).inputValue()).toBe("");
      expect(await composer.getByRole("link").count()).toBe(0);
      await composer.getByRole("textbox", { name: "Agent prompt" }).fill("Tighten this tile.");
      await page.waitForTimeout(300);
      expect(await composer.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(false);
      await composer.getByRole("combobox", { name: "Agent", exact: true }).selectOption("custom");
      await composer.getByRole("textbox", { name: "Custom agent command" }).fill("my-acp-agent --acp");
      expect(await composer.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  }, 20_000);

  test("Settings stores a detected agent's command, returns selection to each dashboard, and accepts a custom command", async () => {
    const page = await openFixture();
    try {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings" });
      const card = settings.getByRole("region", { name: "Dashboard agent" });
      const select = card.getByRole("combobox", { name: "Agent", exact: true });
      await card.getByText("(now claude-agent-acp)", { exact: false }).waitFor();
      expect(await select.inputValue()).toBe("bundle");
      expect(await select.locator("option").allTextContents())
        .toEqual(["Each dashboard's choice", "Claude Code", "Codex", "Gemini CLI", "Custom command"]);
      const save = card.getByRole("button", { name: "Save", exact: true });
      expect(await save.isEnabled()).toBe(false);

      await select.selectOption("detected:codex");
      await card.getByText("Runs codex-acp from the project root.", { exact: true }).waitFor();
      await save.click();
      await page.getByRole("status").getByText("The app-wide agent is now codex-acp.", { exact: true }).waitFor();
      expect(await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAppSettings()).dashBoredAgent)).toBe("codex-acp");
      expect(await select.inputValue()).toBe("detected:codex");

      await select.selectOption("custom");
      const custom = card.getByRole("textbox", { name: "Custom agent command" });
      await custom.fill("");
      expect(await save.isEnabled()).toBe(false);
      await custom.fill("my-acp-agent --acp");
      await card.getByText("Runs my-acp-agent --acp from the project root.", { exact: true }).waitFor();
      await save.click();
      await page.getByRole("status").getByText("The app-wide agent is now my-acp-agent --acp.", { exact: true }).waitFor();

      await select.selectOption("bundle");
      await save.click();
      await page.getByRole("status").getByText("App-wide agent cleared; each dashboard's .env, then a detected agent, is used.", { exact: true }).waitFor();
      expect(await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAppSettings()).dashBoredAgent)).toBeNull();
      await card.getByRole("checkbox", { name: "Enable Codex", exact: true }).waitFor();

      // Nothing configured or detected: say so plainly and list where to get agents.
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setDetectedAgents([]));
      await page.locator(".sidebar__project-link").first().click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await card.getByRole("status").getByText("No enabled agent is ready.", { exact: false }).waitFor();
      expect(await card.getByRole("link").count()).toBe(11);
    } finally { await page.close(); }
  }, 20_000);

  test("the Settings checklist enables missing packages, filters the composer, and clears a disabled default", async () => {
    const page = await openFixture();
    try {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const card = page.getByRole("region", { name: "Dashboard agent" });
      const copilot = card.getByRole("checkbox", { name: "Enable GitHub Copilot CLI", exact: true });
      await copilot.waitFor();
      expect(await copilot.isChecked()).toBe(false);
      await copilot.check();
      await page.getByRole("status").getByText("GitHub Copilot CLI enabled.", { exact: true }).waitFor();
      const select = card.getByRole("combobox", { name: "Agent", exact: true });
      await select.selectOption("detected:copilot");
      await card.getByText("Runs npx -y @github/copilot --acp from the project root.", { exact: true }).waitFor();
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("status").getByText("The app-wide agent is now npx -y @github/copilot --acp.", { exact: true }).waitFor();
      await copilot.uncheck();
      await page.getByRole("status").getByText("GitHub Copilot CLI disabled. App default cleared.", { exact: true }).waitFor();
      expect(await select.inputValue()).toBe("bundle");
      expect(await page.evaluate(async () => (await window.__DASH_BORED_UI_HARNESS_HOST__!.getAppSettings()).enabledAgentIds)).toEqual(["claude", "codex", "gemini"]);

      await card.getByRole("checkbox", { name: "Enable Codex", exact: true }).uncheck();
      await page.getByRole("status").getByText("Codex disabled.", { exact: true }).waitFor();
      await page.locator(".sidebar__project-link").first().click();
      await page.locator('[data-node-id="responsive-card"] header').first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Change with agent…", exact: true }).click();
      const composer = page.getByRole("dialog", { name: "Ask the agent" });
      await composer.getByRole("combobox", { name: "Agent", exact: true }).waitFor();
      expect(await composer.locator('option[value="detected:codex"]').count()).toBe(0);
      await composer.getByRole("button", { name: "Enable or set up agents in Settings ↗", exact: true }).click();
      await card.getByRole("checkbox", { name: "Enable Codex", exact: true }).waitFor();
      expect(await card.getByRole("checkbox", { name: "Enable Codex", exact: true }).isChecked()).toBe(false);
      await card.getByRole("button", { name: "Refresh agents", exact: true }).click();
      expect(await card.getByRole("checkbox", { name: "Enable Codex", exact: true }).isChecked()).toBe(false);
      await card.getByRole("checkbox", { name: "Enable Goose", exact: true }).check();
      await page.getByRole("status").getByText("Goose enabled.", { exact: true }).waitFor();
      expect(await select.locator('option[value="detected:goose"]').count()).toBe(0);
      await page.evaluate(() => window.__DASH_BORED_UI_HARNESS_HOST__!.setDetectedAgents(["claude", "codex", "gemini", "goose"]));
      await card.getByRole("button", { name: "Refresh agents", exact: true }).click();
      await select.locator('option[value="detected:goose"]').waitFor({ state: "attached" });
      expect(await card.getByRole("checkbox", { name: "Enable Goose", exact: true }).isChecked()).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 20_000);
});
