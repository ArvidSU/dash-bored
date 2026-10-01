import { expect, test } from "bun:test";
import { pendingActivity, trackActivity, whenIdle } from "../../src/renderer/lib/activity";
import { readDashboardSource } from "../../src/renderer/lib/source";
import type { LocalComponentHost } from "../../src/shared/contracts";

const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("whenIdle resolves true immediately when nothing is in flight", async () => {
  expect(pendingActivity()).toBe(0);
  expect(await whenIdle(1000, frame)).toBe(true);
});

test("whenIdle waits for tracked work, including work started by the settle frame", async () => {
  let finish!: () => void;
  const started = Date.now();
  let late: Promise<void> | undefined;
  const first = trackActivity(new Promise<void>((resolve) => { finish = resolve; }));
  setTimeout(finish, 60);
  // A render effect starting a second fetch while the first completes.
  const idle = whenIdle(2000, async () => {
    await frame();
    if (pendingActivity() === 0) late ??= trackActivity(new Promise<void>((resolve) => setTimeout(resolve, 60)));
  });
  expect(await idle).toBe(true);
  await first;
  await late;
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  expect(pendingActivity()).toBe(0);
});

test("whenIdle reports false at the timeout and counts rejected work as finished", async () => {
  const slow = trackActivity(new Promise<void>((resolve) => setTimeout(resolve, 150)));
  expect(await whenIdle(30, frame)).toBe(false);
  await slow;
  const failing = trackActivity(Promise.reject(new Error("boom")));
  await failing.catch(() => undefined);
  expect(pendingActivity()).toBe(0);
});

test("source reads are tracked until they settle", async () => {
  let release!: () => void;
  const host = {
    http: { request: () => new Promise((resolve) => { release = () => resolve({ status: 200, body: "{}" }); }) },
  } as unknown as LocalComponentHost;
  const read = readDashboardSource({ http: "http://example.test" }, host);
  expect(pendingActivity()).toBe(1);
  release();
  await read;
  expect(pendingActivity()).toBe(0);
});
