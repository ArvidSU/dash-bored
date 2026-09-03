import { describe, expect, test } from "bun:test";
import { safeMarkdownUrl } from "../../src/renderer/lib/safe-url";

describe("safeMarkdownUrl", () => {
  test("allows ordinary web, mail, relative, and fragment links", () => {
    expect(safeMarkdownUrl("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(safeMarkdownUrl("mailto:hello@example.com")).toBe(
      "mailto:hello@example.com",
    );
    expect(safeMarkdownUrl("./guide.md")).toBe("./guide.md");
    expect(safeMarkdownUrl("#configuration")).toBe("#configuration");
  });

  test("rejects executable and malformed absolute schemes", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html,hello")).toBe("");
    expect(safeMarkdownUrl("not a url")).toBe("");
  });
});
