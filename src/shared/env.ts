/** Bundle defaults are read as data; the environment component owns editing. */
export interface ParsedEnvironment {
  entries: Array<{ key: string; value: string }>;
  invalidLines: number;
}

function closingQuote(source: string): number {
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === source[0]) return index;
  }
  return -1;
}

function parseValue(source: string): string | null {
  const value = source.replace(/^[ \t]*/, "");
  if (value.startsWith('"') || value.startsWith("'")) {
    const closing = closingQuote(value);
    if (closing < 0) return null;
    const remainder = value.slice(closing + 1).trim();
    if (remainder && !remainder.startsWith("#")) return null;
    const quoted = value.slice(1, closing);
    return value[0] === "'" ? quoted.replaceAll("\\'", "'") : quoted.replace(/\\([\\"nrt$])/g, (_match, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    });
  }
  const comment = value.search(/(?:^|\s)#/);
  return (comment < 0 ? value : value.slice(0, comment)).trimEnd();
}

/** Preserves entry order and duplicate keys; consumers choose their precedence. */
export function parseEnv(source: string): ParsedEnvironment {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const result: ParsedEnvironment = { entries: [], invalidLines: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=([\s\S]*)$/);
    if (!match) { result.invalidLines += 1; continue; }
    let valueSource = match[2]!;
    let quoted = valueSource.replace(/^[ \t]*/, "");
    if (quoted.startsWith('"') || quoted.startsWith("'")) {
      while (closingQuote(quoted) < 0 && index + 1 < lines.length) {
        const continuation = `\n${lines[++index]!}`;
        valueSource += continuation;
        quoted += continuation;
      }
    }
    const value = parseValue(valueSource);
    if (value === null) result.invalidLines += 1;
    else result.entries.push({ key: match[1]!, value });
  }
  return result;
}
