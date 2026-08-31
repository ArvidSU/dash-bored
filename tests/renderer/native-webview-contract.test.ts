import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("native webview proof foundation", () => {
  test("keeps overlay visibility and dimension synchronization explicit", async () => {
    const source = await readFile("src/renderer/ComponentWebviewSurface.tsx", "utf8");
    expect(source).toContain("view.toggleHidden(!visible)");
    expect(source).toContain("if (visible) view.syncDimensions(true)");
    expect(source).toContain("ComponentVisibilityContext");
  });
});
