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

export function todoStatus(todos: Todo[]): { state: "healthy" | "warning"; detail: string } {
  const open = todos.filter((todo) => !todo.done);
  const bugs = open.filter((todo) => todo.tags.some((tag) => tag.toLowerCase() === "bug"));
  return {
    state: bugs.length ? "warning" : "healthy",
    detail: `${open.length} open · ${todos.length - open.length} done${bugs.length ? ` · ${bugs.length} open bug${bugs.length === 1 ? "" : "s"}` : ""}`,
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

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "status" && mode !== "chart") {
    process.stderr.write("Usage: bun run .dash-bored/scripts/todo-stats.ts <status|chart>\n");
    process.exit(2);
  }
  const path = process.env.DASH_BORED_CONFIG || ".dash-bored/dash-bored.yaml";
  const nodeId = process.env.DASH_BORED_TODO_NODE || "yaml-todo";
  const todos = findTodos(parse(await Bun.file(path).text()), nodeId);
  if (!todos) {
    process.stderr.write(`No todos found on node ${nodeId} in ${path}.\n`);
    process.exit(1);
  }
  emit(mode === "status" ? todoStatus(todos) : todoChart(todos));
}
