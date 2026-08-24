export type EnvQuoteStyle = "none" | "single" | "double";

export interface EnvEntry {
  key: string;
  value: string;
  quote: EnvQuoteStyle;
  leading: string;
  exportPrefix: string;
  beforeEquals: string;
  afterEquals: string;
  comment: string;
}

export type EnvLine =
  | { kind: "entry"; entry: EnvEntry }
  | { kind: "other"; source: string; type: "blank" | "comment" | "raw" };

export interface EnvDocument {
  lines: EnvLine[];
  lineEnding: "\n" | "\r\n";
  trailingNewline: boolean;
}

export interface EnvEntryRow {
  lineIndex: number;
  entry: EnvEntry;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decodeDoubleQuoted(value: string): string {
  return value.replace(/\\([\\"nrt$])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function findUnquotedComment(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "#" && /\s/.test(value[index - 1] ?? "")) return index;
  }
  return -1;
}

function parseValue(source: string): Pick<EnvEntry, "value" | "quote" | "comment"> {
  const afterEquals = source.match(/^[ \t]*/)?.[0] ?? "";
  const valueSource = source.slice(afterEquals.length);
  if (valueSource.startsWith('"')) {
    const closing = valueSource.lastIndexOf('"');
    if (closing > 0) {
      const remainder = valueSource.slice(closing + 1).trim();
      return {
        value: decodeDoubleQuoted(valueSource.slice(1, closing)),
        quote: "double",
        comment: remainder.startsWith("#") ? remainder : "",
      };
    }
  }
  if (valueSource.startsWith("'")) {
    const closing = valueSource.lastIndexOf("'");
    if (closing > 0) {
      const remainder = valueSource.slice(closing + 1).trim();
      return {
        value: valueSource.slice(1, closing).replaceAll("\\'", "'"),
        quote: "single",
        comment: remainder.startsWith("#") ? remainder : "",
      };
    }
  }

  const commentIndex = findUnquotedComment(valueSource);
  const value = commentIndex === -1 ? valueSource.trimEnd() : valueSource.slice(0, commentIndex).trimEnd();
  return {
    value,
    quote: "none",
    comment: commentIndex === -1 ? "" : valueSource.slice(commentIndex).trim(),
  };
}

function parseLine(source: string): EnvLine {
  const trimmed = source.trim();
  if (trimmed === "") return { kind: "other", source, type: "blank" };
  if (trimmed.startsWith("#")) return { kind: "other", source, type: "comment" };

  const match = source.match(/^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)([ \t]*)=(.*)$/);
  if (!match) return { kind: "other", source, type: "raw" };
  const [, leading, exportPrefix, key, beforeEquals, valueSource] = match;
  const parsed = parseValue(valueSource ?? "");
  return {
    kind: "entry",
    entry: {
      key: key ?? "",
      value: parsed.value,
      quote: parsed.quote,
      leading: leading ?? "",
      exportPrefix: exportPrefix ?? "",
      beforeEquals: beforeEquals ?? "",
      afterEquals: (valueSource ?? "").match(/^[ \t]*/)?.[0] ?? "",
      comment: parsed.comment,
    },
  };
}

export function parseEnv(source: string): EnvDocument {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const rawLines = normalized.split("\n");
  if (trailingNewline) rawLines.pop();
  return {
    lines: normalized === "" ? [] : rawLines.map(parseLine),
    lineEnding,
    trailingNewline,
  };
}

function formatValue(entry: EnvEntry): string {
  if (entry.quote === "single") return `'${entry.value.replaceAll("'", "\\'")}'`;
  if (entry.quote === "double") {
    return `"${entry.value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")}"`;
  }
  if (entry.value === "") return "";
  if (/\s|#/.test(entry.value)) {
    return `"${entry.value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return entry.value;
}

export function formatEnvEntry(entry: EnvEntry): string {
  const comment = entry.comment ? ` ${entry.comment}` : "";
  return `${entry.leading}${entry.exportPrefix}${entry.key}${entry.beforeEquals}=${entry.afterEquals}${formatValue(entry)}${comment}`;
}

export function serializeEnv(document: EnvDocument): string {
  const source = document.lines
    .map((line) => (line.kind === "entry" ? formatEnvEntry(line.entry) : line.source))
    .join(document.lineEnding);
  return document.trailingNewline && document.lines.length > 0
    ? `${source}${document.lineEnding}`
    : source;
}

export function envEntries(document: EnvDocument): EnvEntryRow[] {
  return document.lines.flatMap((line, lineIndex) =>
    line.kind === "entry" ? [{ lineIndex, entry: line.entry }] : [],
  );
}

export function invalidEnvLineCount(document: EnvDocument): number {
  return document.lines.filter((line) => line.kind === "other" && line.type === "raw").length;
}

export function updateEnvEntry(
  document: EnvDocument,
  lineIndex: number,
  patch: Partial<Pick<EnvEntry, "key" | "value">>,
): EnvDocument {
  const line = document.lines[lineIndex];
  if (!line || line.kind !== "entry") return document;
  const lines = [...document.lines];
  lines[lineIndex] = { kind: "entry", entry: { ...line.entry, ...patch } };
  return { ...document, lines };
}

export function appendEnvEntry(document: EnvDocument): EnvDocument {
  return {
    ...document,
    lines: [
      ...document.lines,
      {
        kind: "entry",
        entry: {
          key: "NEW_VARIABLE",
          value: "",
          quote: "none",
          leading: "",
          exportPrefix: "",
          beforeEquals: "",
          afterEquals: "",
          comment: "",
        },
      },
    ],
    trailingNewline: document.lines.length > 0 ? document.trailingNewline : true,
  };
}

export function removeEnvEntry(document: EnvDocument, lineIndex: number): EnvDocument {
  return { ...document, lines: document.lines.filter((_line, index) => index !== lineIndex) };
}

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
