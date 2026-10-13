import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { externalLinkUrl, openNewWindowsExternally } from "../../src/main/external-links";

const newWindow = (detail: unknown) => ({ data: { detail } });

describe("external links", () => {
  test("accepts web and mail links from either event detail shape", () => {
    expect(externalLinkUrl(newWindow({ url: "https://example.com/setup", isCmdClick: false }))).toBe("https://example.com/setup");
    expect(externalLinkUrl(newWindow("http://localhost:3000/"))).toBe("http://localhost:3000/");
    expect(externalLinkUrl(newWindow({ url: "mailto:help@example.com" }))).toBe("mailto:help@example.com");
  });

  test("drops schemes that should not leave the app", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "views://mainview/index.html", "slack://open", "not a url"]) {
      expect(externalLinkUrl(newWindow({ url }))).toBeNull();
    }
    expect(externalLinkUrl(newWindow({}))).toBeNull();
    expect(externalLinkUrl(null)).toBeNull();
  });

  test("opens only the main webview's new-window requests", () => {
    const events = new EventEmitter();
    const opened: string[] = [];
    openNewWindowsExternally(events, 1, (url) => { opened.push(url); return true; });

    events.emit("new-window-open-1", newWindow({ url: "https://example.com/a" }));
    events.emit("new-window-open-2", newWindow({ url: "https://example.com/embedded" }));
    events.emit("new-window-open-1", newWindow({ url: "file:///tmp/x" }));

    expect(opened).toEqual(["https://example.com/a"]);
  });
});
