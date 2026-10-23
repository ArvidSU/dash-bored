import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("native webview proof foundation", () => {
  test("keeps overlay visibility and dimension synchronization explicit", async () => {
    const source = await readFile("src/renderer/render/ComponentWebviewSurface.tsx", "utf8");
    expect(source).toContain("view.toggleHidden(!visible)");
    expect(source).toContain("view.syncDimensions?.(true)");
    expect(source).toContain("typeof view.toggleHidden");
    expect(source).toContain("window.addEventListener(\"scroll\", scheduleSync, true)");
    expect(source).toContain("placeholderRef.current?.getBoundingClientRect()");
    expect(source).toContain("const { width, height } = shell.getBoundingClientRect()");
    expect(source).not.toContain("Math.max(320");
    expect(source).not.toContain("<header");
    expect(source).not.toContain("<button");
    expect(source).toContain('view.style.setProperty("width", `${width}px`, "important")');
    expect(source).toContain('view.style.setProperty("height", `${height}px`, "important")');
    expect(source).toContain("ComponentVisibilityContext");
  });

  test("accepts caller-owned layout and reload intent", async () => {
    const source = await readFile("src/renderer/render/ComponentWebviewSurface.tsx", "utf8");
    expect(source).toContain("style={style}");
    expect(source).toContain("previousReload.current !== reloadKey");
    expect(source).toContain("sandbox src={url}");
    expect(source).not.toContain("aspect-ratio");
  });
});
