import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("native webview proof foundation", () => {
  test("keeps overlay visibility and dimension synchronization explicit", async () => {
    const source = await readFile("src/renderer/ComponentWebviewSurface.tsx", "utf8");
    expect(source).toContain("view.toggleHidden(!visible)");
    expect(source).toContain("view.syncDimensions?.(true)");
    expect(source).toContain("typeof view.toggleHidden");
    expect(source).toContain("window.addEventListener(\"scroll\", scheduleSync, true)");
    expect(source).toContain("placeholderRef.current?.getBoundingClientRect()");
    expect(source).toContain("shellRef.current?.clientWidth");
    expect(source).toContain('view.style.setProperty("width", `${width}px`, "important")');
    expect(source).toContain('view.style.setProperty("height", `${height}px`, "important")');
    expect(source).toContain("ComponentVisibilityContext");
  });

  test("waits for an in-flow placeholder before mounting the native tag", async () => {
    const styles = await readFile("src/renderer/builtins/webview/webview.css", "utf8");
    expect(styles).toContain(`.webview-shell__placeholder,\n.webview-shell__view {\n  display: block;\n  aspect-ratio: 16 / 9;\n  width: 100%;\n  min-height: 320px;\n  max-height: 720px;`);
    expect(styles).toContain("aspect-ratio: 16 / 9;");
    expect(styles).not.toContain("position: fixed;");
  });
});
