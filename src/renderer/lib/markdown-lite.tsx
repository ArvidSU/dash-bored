import { Fragment, memo, useMemo } from "react";
import type { ReactNode } from "react";
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
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~<]/;
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

const WORD = /[\p{L}\p{N}]/u;

function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/**
 * The index of the delimiter that closes an emphasis run opened before
 * `from`, or -1. A closer follows non-space text; `_` never closes inside a
 * word, and a single `*` is never half of `**`.
 */
function findEmphasisCloser(text: string, delimiter: string, from: number): number {
  let index = text.indexOf(delimiter, from);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + delimiter.length];
    const doubled = delimiter.length === 1 && (after === delimiter || before === delimiter);
    const intraword = delimiter[0] === "_" && after !== undefined && WORD.test(after);
    if (index > from && !isSpace(before) && !doubled && !intraword) return index;
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

/** Start positions of every maximal backtick run, in order, by run length. */
function backtickRuns(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  let index = text.indexOf("`");
  while (index !== -1) {
    let end = index + 1;
    while (text[end] === "`") end += 1;
    const positions = runs.get(end - index);
    if (positions) positions.push(index);
    else runs.set(end - index, [index]);
    index = text.indexOf("`", end);
  }
  return runs;
}

/** A link destination plus an optional quoted title; anything else is not a link. */
const LINK_TARGET = /^\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/;
/** Targets with whitespace (a title) are checked only up to this length. */
const MAX_TITLED_TARGET = 2_048;

export function parseMarkdownInline(text: string): MarkdownInline[] {
  const output: MarkdownInline[] = [];
  // Once a delimiter has no closer from some position, none exists further on:
  // remembering that keeps pathological input linear.
  const unmatched = new Set<string>();
  // A code span closes on the next maximal backtick run of the same length.
  // Runs are indexed once, and since the scan only moves forward each length
  // keeps a cursor, so matching stays linear however the runs are ordered.
  let runs: Map<number, number[]> | null = null;
  const runCursors = new Map<number, number>();
  const codeSpanCloser = (length: number, from: number): number => {
    runs ??= backtickRuns(text);
    const positions = runs.get(length);
    if (!positions) return -1;
    let cursor = runCursors.get(length) ?? 0;
    while (cursor < positions.length && positions[cursor]! < from) cursor += 1;
    runCursors.set(length, cursor);
    return positions[cursor] ?? -1;
  };
  // The scan only moves forward, so the first match after an earlier position
  // is still the first match after a later one until the scan passes it.
  const found = new Map<string, number>();
  const firstAfter = (needle: string, from: number): number => {
    const known = found.get(needle);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const next = text.indexOf(needle, from);
    found.set(needle, next);
    return next;
  };
  const whitespace = /\s/g;
  let whitespaceAt: number | undefined;
  const firstWhitespaceAfter = (from: number): number => {
    if (whitespaceAt !== undefined && (whitespaceAt === -1 || whitespaceAt >= from)) return whitespaceAt;
    whitespace.lastIndex = from;
    whitespaceAt = whitespace.exec(text)?.index ?? -1;
    return whitespaceAt;
  };
  /** The URL of a link target, or null when the parentheses hold prose such as `arr[0](see below)`. */
  const linkUrl = (start: number, end: number): string | null => {
    const space = firstWhitespaceAfter(start);
    // Without whitespace the whole target is the URL; a link consumes it, so this stays linear.
    if (space === -1 || space >= end) return text.slice(start, end) || null;
    if (end - start > MAX_TITLED_TARGET) return null;
    return LINK_TARGET.exec(text.slice(start, end))?.[1] ?? null;
  };
  let buffer = "";
  const flush = () => {
    if (buffer) output.push({ type: "text", text: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\" && index + 1 < text.length && ESCAPABLE.test(text[index + 1]!)) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (character === "\n") {
      flush();
      output.push({ type: "break" });
      index += 1;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (text[index + run] === "`") run += 1;
      const close = codeSpanCloser(run, index + run);
      if (close === -1) {
        buffer += "`".repeat(run);
        index += run;
        continue;
      }
      flush();
      let code = text.slice(index + run, close).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
      output.push({ type: "code", text: code });
      index = close + run;
      continue;
    }
    if (character === "*" || character === "_") {
      const delimiter = text[index + 1] === character ? character + character : character;
      const before = text[index - 1];
      const after = text[index + delimiter.length];
      const canOpen = !isSpace(after) && !(character === "_" && before !== undefined && WORD.test(before));
      if (canOpen && !unmatched.has(delimiter)) {
        const close = findEmphasisCloser(text, delimiter, index + delimiter.length);
        if (close === -1) {
          unmatched.add(delimiter);
        } else {
          flush();
          const children = parseMarkdownInline(text.slice(index + delimiter.length, close));
          output.push(delimiter.length === 2 ? { type: "strong", children } : { type: "em", children });
          index = close + delimiter.length;
          continue;
        }
      }
      buffer += delimiter;
      index += delimiter.length;
      continue;
    }
    if (character === "[") {
      // Labels do not nest; the first `]` ends one.
      const labelEnd = firstAfter("]", index + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = firstAfter(")", labelEnd + 2);
        const url = urlEnd === -1 ? null : linkUrl(labelEnd + 2, urlEnd);
        if (url) {
          flush();
          output.push({ type: "link", children: parseMarkdownInline(text.slice(index + 1, labelEnd)), url: url.replace(/^<|>$/g, "") });
          index = urlEnd + 1;
          continue;
        }
      }
    }
    if (character === "<") {
      const autolink = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(index, index + 2_048));
      if (autolink) {
        flush();
        output.push({ type: "link", children: [], url: autolink[1]! });
        index += autolink[0].length;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();
  return output;
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
