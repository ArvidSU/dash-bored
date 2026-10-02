import { migrateTodoItems } from "../../migrations/todo-ids";
import type { TodoItem } from "../../shared/todo";

/** Reads the bounded todo value declared in this component's YAML props. */
export function todoItemsFromProps(value: unknown): TodoItem[] {
  return migrateTodoItems(value).items;
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
