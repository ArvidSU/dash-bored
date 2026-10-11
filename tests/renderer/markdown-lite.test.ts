import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownLite, parseMarkdownBlocks, parseMarkdownInline } from "../../src/renderer/lib/markdown-lite";

function html(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownLite, { text }));
}

describe("markdown-lite inline parser", () => {
  test("parses emphasis, code spans, links, escapes, and breaks", () => {
    expect(parseMarkdownInline("a **bold** and *em* and _under_ `x * y`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "em" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "under" }] },
      { type: "text", text: " " },
      { type: "code", text: "x * y" },
    ]);
    expect(parseMarkdownInline("[docs](https://example.com/a \"t\")")).toEqual([
      { type: "link", children: [{ type: "text", text: "docs" }], url: "https://example.com/a" },
    ]);
    expect(parseMarkdownInline("<https://example.com>")).toEqual([
      { type: "link", children: [], url: "https://example.com" },
    ]);
    expect(parseMarkdownInline("\\*not em\\* a\nb")).toEqual([
      { type: "text", text: "*not em* a" },
      { type: "break" },
      { type: "text", text: "b" },
    ]);
  });

  test("leaves unmatched and intraword delimiters as text", () => {
    expect(parseMarkdownInline("snake_case_name and 2 * 3 * 4")).toEqual([
      { type: "text", text: "snake_case_name and 2 * 3 * 4" },
    ]);
    expect(parseMarkdownInline("**open `tick [label](")).toEqual([
      { type: "text", text: "**open `tick [label](" },
    ]);
  });

  test("closes a code span only on a backtick run of the same length", () => {
    expect(parseMarkdownInline("`a```b` c")).toEqual([
      { type: "code", text: "a```b" },
      { type: "text", text: " c" },
    ]);
    expect(parseMarkdownInline("`` a ` b ``")).toEqual([{ type: "code", text: "a ` b" }]);
  });
});

describe("markdown-lite block parser", () => {
  test("parses headings, fences, lists, quotes, tables, and rules", () => {
    const blocks = parseMarkdownBlocks([
      "## Plan ##",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "- one",
      "  - nested",
      "- two",
      "",
      "3. three",
      "> quoted",
      "| a | b |",
      "|---|---|",
      "***",
      "Tail",
    ].join("\n"));
    expect(blocks.map((block) => block.type)).toEqual(["heading", "code", "list", "list", "quote", "table", "rule", "paragraph"]);
    expect(blocks[0]).toEqual({ type: "heading", level: 2, inline: [{ type: "text", text: "Plan" }] });
    expect(blocks[1]).toEqual({ type: "code", language: "ts", text: "const a = 1;" });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [
        { inline: [{ type: "text", text: "one" }], children: [{ type: "list", items: [{ inline: [{ type: "text", text: "nested" }] }] }] },
        { inline: [{ type: "text", text: "two" }] },
      ],
    });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[5]).toEqual({ type: "table", text: "| a | b |\n|---|---|" });
  });

  test("runs an unclosed fence (a streaming message) to the end", () => {
    expect(parseMarkdownBlocks("text\n```\npartial")).toEqual([
      { type: "paragraph", inline: [{ type: "text", text: "text" }] },
      { type: "code", language: "", text: "partial" },
    ]);
  });

  test("keeps markers as text beyond the nesting limit", () => {
    const quotes = parseMarkdownBlocks(">".repeat(40) + " deep");
    let depth = 0;
    let block = quotes[0];
    while (block?.type === "quote") {
      depth += 1;
      block = block.blocks[0];
    }
    expect(depth).toBe(8);
    expect(block).toMatchObject({ type: "paragraph" });
  });
});

describe("markdown-lite rendering", () => {
  test("renders safe elements and never emits markup from the source", () => {
    const output = html("Hi <img src=x onerror=alert(1)> **there**\n\n[site](javascript:void) <https://example.com>");
    expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(output).toContain("<strong>there</strong>");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("<a");
    expect(output).not.toContain("href");
    expect(output).toContain('<span class="markdown-lite__link">site <span class="markdown-lite__url">(javascript:void)</span></span>');
    expect(output).toContain('<span class="markdown-lite__url">https://example.com</span>');
  });

  test("renders headings as bold text, code blocks, and ordered list starts", () => {
    const output = html("# Title\n\n```sh\nls\n```\n\n4. four\n5. five");
    expect(output).toContain('<p class="markdown-lite__heading"><strong>Title</strong></p>');
    expect(output).toContain('<pre class="markdown-lite__code" data-language="sh"><code>ls</code></pre>');
    expect(output).toContain('<ol start="4"><li>four</li><li>five</li></ol>');
  });

  test("stays fast on pathological input", () => {
    const n = 20_000;
    const inputs = [
      "*a ".repeat(n),
      "**a ".repeat(n),
      "_a ".repeat(n),
      "*_`[".repeat(n),
      "[a](".repeat(n),
      "<http://".repeat(n),
      "# a" + " ".repeat(n) + "b",
      "```" + "a".repeat(n) + "`",
      ">".repeat(n),
      "- a" + "\n".repeat(n) + "b",
      "- a\n\n".repeat(n),
      Array.from({ length: 2_000 }, (_, index) => " ".repeat(index) + "- a").join("\n"),
      "- ".repeat(n) + "x",
      "|a|\n".repeat(n),
    ];
    for (const input of inputs) {
      const started = performance.now();
      html(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
