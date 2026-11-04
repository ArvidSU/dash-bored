import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validWindowDragRegions } from "../../src/shared/window-drag";

test("native drag geometry rejects invalid coordinates and unbounded regions", () => {
  const rect = { x: 0, y: 0, width: 800, height: 60 };
  const regions = { width: 800, height: 600, drag: [rect], exclude: [] };
  expect(validWindowDragRegions(regions)).toBe(true);
  expect(validWindowDragRegions({ ...regions, width: 0 })).toBe(false);
  expect(validWindowDragRegions({ ...regions, drag: [{ ...rect, x: NaN }] })).toBe(false);
  expect(validWindowDragRegions({ ...regions, drag: Array(9).fill(rect) })).toBe(false);
});

test.skipIf(process.platform !== "darwin")("AppKit drag view preserves controls, first mouse, repeated gestures, and queued positions", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "dash-window-drag-"));
  try {
    const binary = join(scratch, "window-drag-test");
    const compile = Bun.spawn(["xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa",
      "tests/native/window-drag.m", "-o", binary], { stdout: "inherit", stderr: "inherit" });
    expect(await compile.exited).toBe(0);
    const run = Bun.spawn([binary], { stdout: "inherit", stderr: "inherit" });
    expect(await run.exited).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 20_000);
