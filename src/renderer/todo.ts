export interface TodoItem {
  description: string;
  done: boolean;
  tags: string[];
}

const TODO_KEYS = new Set(["description", "done", "tags"]);

function parseError(message: string): Error {
  return new Error(`Todo YAML: ${message}`);
}

function withoutComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseString(value: string, context: string): string {
  const source = withoutComment(value).trim();
  if (source === "") throw parseError(`${context} must be a non-empty string.`);
  if (source.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw parseError(`${context} has invalid double-quoted text.`);
    }
  }
  if (source.startsWith("'")) {
    if (!source.endsWith("'") || source.length < 2) {
      throw parseError(`${context} has invalid single-quoted text.`);
    }
    return source.slice(1, -1).replaceAll("''", "'");
  }
  return source;
}

function parseBoolean(value: string, context: string): boolean {
  const source = withoutComment(value).trim();
  if (source === "true") return true;
  if (source === "false") return false;
  throw parseError(`${context} must be true or false.`);
}

function splitFlowSequence(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'" && inner[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ",") {
      parts.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

function parseTags(value: string, context: string): string[] {
  const source = withoutComment(value).trim();
  if (!source.startsWith("[") || !source.endsWith("]")) {
    throw parseError(`${context} must be a YAML sequence.`);
  }
  const tags = splitFlowSequence(source).map((tag, index) =>
    parseString(tag, `${context}[${index}]`),
  );
  if (tags.some((tag) => tag.trim() === "")) throw parseError(`${context} cannot contain empty tags.`);
  return [...new Set(tags)];
}

function parsePair(value: string, context: string): [string, string] {
  const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(value);
  const key = match?.[1];
  if (key === undefined) throw parseError(`${context} must contain a field and a value.`);
  return [key, match?.[2] ?? ""];
}

interface TodoDraft {
  keys: Set<string>;
  description?: string;
  done?: boolean;
  tags?: string[];
}

function assignField(draft: TodoDraft, key: string, value: string, context: string): void {
  if (!TODO_KEYS.has(key)) throw parseError(`${context} contains unsupported field ${JSON.stringify(key)}.`);
  if (draft.keys.has(key)) throw parseError(`${context} contains duplicate field ${JSON.stringify(key)}.`);
  draft.keys.add(key);
  if (key === "description") draft.description = parseString(value, `${context}.description`);
  else if (key === "done") draft.done = parseBoolean(value, `${context}.done`);
  else if (value.trim() === "") draft.tags = [];
  else draft.tags = parseTags(value, `${context}.tags`);
}

function finishDraft(draft: TodoDraft, index: number): TodoItem {
  if (draft.description === undefined || draft.description.trim() === "") {
    throw parseError(`item ${index + 1} needs a description.`);
  }
  return {
    description: draft.description,
    done: draft.done ?? false,
    tags: draft.tags ?? [],
  };
}

/** Parse the deliberately small YAML document used by the todo component. */
export function parseTodoYaml(source: string): TodoItem[] {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (source.trim() === "") return [];

  let foundTodos = false;
  let current: TodoDraft | null = null;
  let activeTags: string[] | null = null;
  const items: TodoItem[] = [];

  const finishCurrent = (): void => {
    if (current !== null) items.push(finishDraft(current, items.length));
    current = null;
    activeTags = null;
  };

  for (const [lineIndex, rawLine] of lines.entries()) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const value = rawLine.trim();

    if (indent === 0) {
      if (value === "todos: []") {
        if (foundTodos) throw parseError(`line ${lineIndex + 1} repeats todos.`);
        foundTodos = true;
        continue;
      }
      if (value !== "todos:") throw parseError(`line ${lineIndex + 1} has an unsupported root field.`);
      if (foundTodos) throw parseError(`line ${lineIndex + 1} repeats todos.`);
      foundTodos = true;
      continue;
    }

    if (!foundTodos) throw parseError(`line ${lineIndex + 1} must start with todos:.`);
    if (indent === 2 && value.startsWith("-")) {
      finishCurrent();
      current = { keys: new Set() };
      const remainder = value.slice(1).trim();
      if (remainder !== "") {
        const [key, fieldValue] = parsePair(remainder, `line ${lineIndex + 1}`);
        assignField(current, key, fieldValue, `item ${items.length + 1}`);
      }
      continue;
    }

    if (current === null) throw parseError(`line ${lineIndex + 1} is not inside a todo item.`);
    if (activeTags !== null && indent === 6 && value.startsWith("-")) {
      const tag = parseString(value.slice(1).trim(), `item ${items.length + 1}.tags`);
      if (tag.trim() === "") throw parseError(`item ${items.length + 1}.tags cannot contain empty tags.`);
      if (!activeTags.includes(tag)) activeTags.push(tag);
      continue;
    }
    if (indent !== 4) throw parseError(`line ${lineIndex + 1} has unsupported indentation.`);
    const [key, fieldValue] = parsePair(value, `line ${lineIndex + 1}`);
    if (key === "tags" && fieldValue.trim() === "") {
      if (current.keys.has(key)) throw parseError(`item ${items.length + 1} contains duplicate field ${JSON.stringify(key)}.`);
      current.keys.add(key);
      current.tags = [];
      activeTags = current.tags;
    } else {
      activeTags = null;
      assignField(current, key, fieldValue, `item ${items.length + 1}`);
    }
  }

  finishCurrent();
  if (!foundTodos) throw parseError("the document must contain a todos field.");
  return items;
}

export function serializeTodoYaml(items: readonly TodoItem[]): string {
  const normalized = items.map((item, index) => finishDraft({
    keys: new Set(["description", "done", "tags"]),
    description: item.description,
    done: item.done,
    tags: item.tags,
  }, index));
  if (normalized.length === 0) return "todos: []\n";
  return [
    "todos:",
    ...normalized.flatMap((item) => [
      `  - description: ${JSON.stringify(item.description)}`,
      `    done: ${item.done ? "true" : "false"}`,
      `    tags: ${JSON.stringify(item.tags)}`,
    ]),
    "",
  ].join("\n");
}

export function sortTodos(items: readonly TodoItem[]): TodoItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => Number(left.item.done) - Number(right.item.done) || left.index - right.index)
    .map(({ item }) => item);
}

export function filterTodos(items: readonly TodoItem[], tag: string): TodoItem[] {
  if (tag === "") return [...items];
  return items.filter((item) => item.tags.includes(tag));
}

export function todoTags(items: readonly TodoItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.tags))].sort((left, right) => left.localeCompare(right));
}
