import { parse } from "yaml";
import { emit } from "./lib/run";

export interface Todo {
  id: string;
  description: string;
  done: boolean;
  tags: string[];
}

/** Find the todos of the node with `nodeId` anywhere in a parsed dashboard. */
export function findTodos(value: unknown, nodeId: string): Todo[] | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTodos(entry, nodeId);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.id === nodeId) {
    const props = record.props as { todos?: Todo[] } | undefined;
    if (Array.isArray(props?.todos)) return props.todos;
  }
  for (const entry of Object.values(record)) {
    const found = findTodos(entry, nodeId);
    if (found) return found;
  }
  return undefined;
}

const isBug = (todo: Todo) => todo.tags.some((tag) => tag.toLowerCase() === "bug");

export interface TodoStatus {
  state: "healthy" | "warning";
  detail: string;
  segments: Array<{ label: string; value: number; state: string }>;
}

/** Backlog health plus its part-of-whole breakdown: done, open, and open bugs. */
export function todoStatus(todos: Todo[]): TodoStatus {
  const open = todos.filter((todo) => !todo.done);
  const bugs = open.filter(isBug);
  const done = todos.length - open.length;
  const percent = todos.length ? Math.round(done / todos.length * 100) : 0;
  return {
    state: bugs.length ? "warning" : "healthy",
    detail: `${percent}% done · ${open.length} open · ${done} done${bugs.length ? ` · ${bugs.length} open bug${bugs.length === 1 ? "" : "s"}` : ""}`,
    segments: [
      { label: "Done", value: done, state: "done" },
      { label: "Open", value: open.length - bugs.length, state: "open" },
      { label: "Bugs", value: bugs.length, state: "bug" },
    ],
  };
}

export function todoChart(todos: Todo[]): { labels: string[]; series: Array<{ label: string; values: number[] }> } {
  const counts = new Map<string, { open: number; done: number }>();
  for (const todo of todos) {
    for (const tag of todo.tags.length ? todo.tags : ["untagged"]) {
      const key = tag.toLowerCase();
      const entry = counts.get(key) ?? { open: 0, done: 0 };
      if (todo.done) entry.done += 1;
      else entry.open += 1;
      counts.set(key, entry);
    }
  }
  const labels = [...counts.keys()].sort((left, right) => {
    const a = counts.get(left)!;
    const b = counts.get(right)!;
    return b.open - a.open || left.localeCompare(right);
  });
  return {
    labels,
    series: [
      { label: "Open", values: labels.map((label) => counts.get(label)!.open) },
      { label: "Done", values: labels.map((label) => counts.get(label)!.done) },
    ],
  };
}

/** A bounded scan of real work, with bugs first and source order within each group. */
export function todoAttention(todos: Todo[]) {
  return todos.filter((todo) => !todo.done)
    .sort((a, b) => Number(isBug(b)) - Number(isBug(a)))
    .slice(0, 5)
    .map((todo) => ({ id: todo.id, title: todo.description.length > 100 ? `${todo.description.slice(0, 97).replace(/\s+\S*$/, "")}…` : todo.description,
      // The bug state already says "bug"; keep the other tags for context.
      tags: todo.tags.filter((tag) => tag.toLowerCase() !== "bug"),
      state: isBug(todo) ? "bug" : "open" }));
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "status" && mode !== "chart" && mode !== "attention") {
    process.stderr.write("Usage: bun run .dash-bored/scripts/todo-stats.ts <status|chart|attention>\n");
    process.exit(2);
  }
  const path = process.env.DASH_BORED_CONFIG || ".dash-bored/dash-bored.yaml";
  const nodeId = process.env.DASH_BORED_TODO_NODE || "yaml-todo";
  const todos = findTodos(parse(await Bun.file(path).text()), nodeId);
  if (!todos) {
    process.stderr.write(`No todos found on node ${nodeId} in ${path}.\n`);
    process.exit(1);
  }
  emit(mode === "status" ? todoStatus(todos) : mode === "attention" ? todoAttention(todos) : todoChart(todos));
}
