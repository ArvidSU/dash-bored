import { Fragment, memo, useMemo } from "react";
import type { ReactNode } from "react";
import MarkdownIt, { type Token } from "markdown-it";
import "./markdown-lite.css";

/*
 * A small, safe Markdown subset for agent messages and release notes:
 * paragraphs and line breaks, **bold** and *italic*, `inline code`, fenced
 * code blocks, ordered and unordered lists, block quotes, rules, headings
 * (rendered as bold text), pipe tables (kept as monospace text), and links
 * rendered as their text plus the URL. Everything becomes React text nodes or
 * fixed elements: raw HTML is shown literally, nothing navigates, and no
 * markup is injected.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; children: MarkdownInline[]; url: string }
  | { type: "break" };

export interface MarkdownListItem {
  inline: MarkdownInline[];
  /** Nested lists and code blocks indented under the item. */
  children: MarkdownBlock[];
}

export type MarkdownBlock =
  | { type: "paragraph"; inline: MarkdownInline[] }
  | { type: "heading"; level: number; inline: MarkdownInline[] }
  | { type: "code"; language: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: "quote"; blocks: MarkdownBlock[] }
  | { type: "table"; text: string }
  | { type: "rule" };

// Patterns stay unambiguous (no overlapping repeats) so matching is linear;
// trailing parts of fences and headings are handled in code instead.
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})/;
const HEADING_OPEN = /^\s{0,3}(#{1,6})(?=\s|$)/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
// `[\s\S]` rather than `.`: a U+2028 inside a line must not cut the item short.
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+([\s\S]*)|\s*$)/;
const QUOTE = /^\s{0,3}>\s?([\s\S]*)$/;
const TABLE = /^\s*\|/;
/** Quotes and lists nested deeper than this keep their markers as text. */
const MAX_NESTING = 8;

interface FenceOpen {
  indent: number;
  fence: string;
  language: string;
}

function fenceOpen(line: string): FenceOpen | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const info = line.slice(match[0].length).trim();
  // A backtick fence's info string cannot contain backticks (it is inline code).
  if (match[2]![0] === "`" && info.includes("`")) return null;
  return { indent: indentOf(match[1]!), fence: match[2]!, language: /^\S*/.exec(info)![0] };
}

function heading(line: string): { level: number; text: string } | null {
  const match = HEADING_OPEN.exec(line);
  if (!match) return null;
  let text = line.slice(match[0].length).trim();
  // An optional closing run of `#` counts only when it stands apart.
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === 0) text = "";
  else if (end < text.length && /\s/.test(text[end - 1]!)) text = text.slice(0, end).trimEnd();
  return { level: match[1]!.length, text };
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  text: string;
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  // A thematic break such as `- - -` or `***` is not a list item.
  if (RULE.test(line)) return null;
  const marker = match[2]!;
  const ordered = /\d/.test(marker[0]!);
  return {
    indent: match[1]!.replace(/\t/g, "    ").length,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    text: match[3] ?? "",
  };
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

/** Removes at most `columns` columns of leading spaces and tabs; a tab that reaches past them stays. */
function stripIndent(line: string, columns: number): string {
  let column = 0;
  let index = 0;
  while (index < line.length && column < columns) {
    const width = line[index] === " " ? 1 : line[index] === "\t" ? 4 : 0;
    if (width === 0 || column + width > columns) break;
    column += width;
    index += 1;
  }
  return line.slice(index);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function startsBlock(line: string): boolean {
  return fenceOpen(line) !== null || heading(line) !== null || RULE.test(line) || QUOTE.test(line) || TABLE.test(line) || listMarker(line) !== null;
}

/** Reads a fenced block starting at `start`; an unclosed fence (a streaming message) runs to the end. */
function readFence(lines: readonly string[], start: number): { block: MarkdownBlock; next: number } {
  const { indent, fence, language } = fenceOpen(lines[start]!)!;
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.length >= fence.length && trimmed === fence[0]!.repeat(trimmed.length)) {
      index += 1;
      break;
    }
    body.push(stripIndent(line, indent));
    index += 1;
  }
  return { block: { type: "code", language, text: body.join("\n") }, next: index };
}

function readList(lines: readonly string[], start: number, depth: number): { block: MarkdownBlock; next: number } {
  const first = listMarker(lines[start]!)!;
  const items: MarkdownListItem[] = [];
  let current: { lines: string[]; children: MarkdownBlock[] } | null = null;
  const finish = () => {
    if (current) items.push({ inline: parseMarkdownInline(current.lines.join("\n")), children: current.children });
  };
  let index = start;
  let previousBlank = false;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      // Skip the whole blank run at once so long runs stay linear.
      let nextIndex = index + 1;
      while (nextIndex < lines.length && isBlank(lines[nextIndex]!)) nextIndex += 1;
      const nextLine = lines[nextIndex];
      const nextMarker = nextLine === undefined ? null : listMarker(nextLine);
      const continues = nextLine !== undefined && (
        (nextMarker !== null && nextMarker.indent >= first.indent && (nextMarker.indent > first.indent || nextMarker.ordered === first.ordered))
        || (nextMarker === null && indentOf(nextLine) > first.indent)
      );
      if (!continues) break;
      previousBlank = true;
      index = nextIndex;
      continue;
    }
    const marker = listMarker(line);
    if (marker && marker.indent === first.indent && marker.ordered === first.ordered) {
      finish();
      current = { lines: [marker.text], children: [] };
      previousBlank = false;
      index += 1;
      continue;
    }
    if (marker && marker.indent > first.indent && current && depth < MAX_NESTING) {
      const nested = readList(lines, index, depth + 1);
      current.children.push(nested.block);
      index = nested.next;
      previousBlank = false;
      continue;
    }
    if ((marker && marker.indent <= first.indent) || !current) break;
    const indent = indentOf(line);
    if (indent > first.indent && fenceOpen(line)) {
      const fenced = readFence(lines, index);
      current.children.push(fenced.block);
      index = fenced.next;
      previousBlank = false;
      continue;
    }
    // Indented continuation, or a lazy continuation directly under the item text.
    if (indent > first.indent || (!previousBlank && !startsBlock(line))) {
      if (current.children.length > 0) current.children.push({ type: "paragraph", inline: parseMarkdownInline(line.trim()) });
      else current.lines.push(line.trim());
      previousBlank = false;
      index += 1;
      continue;
    }
    break;
  }
  finish();
  return { block: { type: "list", ordered: first.ordered, start: first.start, items }, next: index };
}

export function parseMarkdownBlocks(source: string, depth = 0): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    if (fenceOpen(line)) {
      const fenced = readFence(lines, index);
      blocks.push(fenced.block);
      index = fenced.next;
      continue;
    }
    const title = heading(line);
    if (title) {
      blocks.push({ type: "heading", level: title.level, inline: parseMarkdownInline(title.text) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (listMarker(line)) {
      const list = readList(lines, index, 0);
      blocks.push(list.block);
      index = list.next;
      continue;
    }
    if (QUOTE.test(line) && depth < MAX_NESTING) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseMarkdownBlocks(quoted.join("\n"), depth + 1) });
      continue;
    }
    if (TABLE.test(line)) {
      const rows: string[] = [];
      while (index < lines.length && TABLE.test(lines[index]!)) {
        rows.push(lines[index]!.trim());
        index += 1;
      }
      blocks.push({ type: "table", text: rows.join("\n") });
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!) && !startsBlock(lines[index]!)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", inline: parseMarkdownInline(paragraph.join("\n")) });
  }
  return blocks;
}

// Tokenize inline Markdown with a maintained parser, then render only our
// fixed React elements. HTML, images, and entities remain literal. Even an
// unsafe URL is safe here because the renderer never creates a link or href.
const inlineMarkdown = new MarkdownIt("commonmark", { html: false }).disable(["entity", "image"]);
inlineMarkdown.validateLink = () => true;
inlineMarkdown.normalizeLink = (url) => url;
inlineMarkdown.normalizeLinkText = (url) => url;
inlineMarkdown.inline.ruler.at("escape", (state, silent) => {
  const next = state.src[state.pos + 1];
  if (state.src[state.pos] !== "\\" || !next || !/[\\`*_{}[\]()#+\-.!|>~<]/.test(next)) return false;
  if (!silent) state.pending += next;
  state.pos += 2;
  return true;
});
inlineMarkdown.inline.ruler.at("newline", (state, silent) => {
  if (state.src[state.pos] !== "\n") return false;
  if (!silent) state.push("softbreak", "br", 0);
  state.pos += 1;
  return true;
});

export function parseMarkdownInline(text: string): MarkdownInline[] {
  const tokens: Token[] = inlineMarkdown.parseInline(text, {})[0]?.children ?? [];
  let position = 0;
  function parse(): MarkdownInline[] {
    const nodes: MarkdownInline[] = [];
    const appendText = (value: string): void => {
      if (!value) return;
      const previous = nodes.at(-1);
      if (previous?.type === "text") previous.text += value;
      else nodes.push({ type: "text", text: value });
    };
    while (position < tokens.length) {
      const token = tokens[position++]!;
      if (token.nesting === -1) break;
      switch (token.type) {
        case "text": appendText(token.content); break;
        case "softbreak": case "hardbreak": nodes.push({ type: "break" }); break;
        case "code_inline": nodes.push({ type: "code", text: token.content }); break;
        case "strong_open": nodes.push({ type: "strong", children: parse() }); break;
        case "em_open": nodes.push({ type: "em", children: parse() }); break;
        case "link_open": {
          const children = parse();
          const url = String(token.attrGet("href") ?? "");
          // An empty destination is prose in this subset, not a link.
          if (!url) {
            appendText("[");
            for (const child of children) child.type === "text" ? appendText(child.text) : nodes.push(child);
            appendText("]()");
          } else if (token.markup === "autolink" && (!/^(?:https?|mailto):/i.test(url)
            || (url.startsWith("mailto:") && inlineText(children) !== url))) {
            // Bare email addresses and other schemes were not part of the subset.
            appendText(`<${inlineText(children)}>`);
          } else nodes.push({ type: "link", children: token.markup === "autolink" ? [] : children, url });
          break;
        }
      }
    }
    return nodes;
  }
  return parse();
}

function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node) => {
    if (node.type === "text" || node.type === "code") return node.text;
    if (node.type === "break") return "\n";
    if (node.type === "link") return inlineText(node.children) || node.url;
    return inlineText(node.children);
  }).join("");
}

function renderInline(nodes: readonly MarkdownInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>;
      case "break": return <br key={index} />;
      case "code": return <code key={index} className="markdown-lite__code-span">{node.text}</code>;
      case "strong": return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em": return <em key={index}>{renderInline(node.children)}</em>;
      case "link": {
        const label = inlineText(node.children).trim();
        // Links never navigate: the label stays text and the URL stays visible.
        if (!label || label === node.url) return <span key={index} className="markdown-lite__url">{node.url}</span>;
        return (
          <span key={index} className="markdown-lite__link">
            {renderInline(node.children)}{" "}
            <span className="markdown-lite__url">({node.url})</span>
          </span>
        );
      }
    }
  });
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.type) {
    case "paragraph": return <p key={index}>{renderInline(block.inline)}</p>;
    case "heading": return <p key={index} className="markdown-lite__heading"><strong>{renderInline(block.inline)}</strong></p>;
    case "code": return (
      <pre key={index} className="markdown-lite__code" data-language={block.language || undefined}>
        <code>{block.text}</code>
      </pre>
    );
    case "table": return <pre key={index} className="markdown-lite__table">{block.text}</pre>;
    case "rule": return <hr key={index} />;
    case "quote": return <blockquote key={index}>{block.blocks.map(renderBlock)}</blockquote>;
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          {renderInline(item.inline)}
          {item.children.map(renderBlock)}
        </li>
      ));
      return block.ordered
        ? <ol key={index} start={block.start === 1 ? undefined : block.start}>{items}</ol>
        : <ul key={index}>{items}</ul>;
    }
  }
}

/** Renders untrusted Markdown safely; re-parses only when the text changes. */
export const MarkdownLite = memo(function MarkdownLite({ text, className }: { text: string; className?: string }): ReactNode {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return <div className={className ? `markdown-lite ${className}` : "markdown-lite"}>{blocks.map(renderBlock)}</div>;
});
