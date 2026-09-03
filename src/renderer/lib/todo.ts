export interface TodoItem {
  description: string;
  done: boolean;
  tags: string[];
}

/** Reads the bounded todo value declared in this component's YAML props. */
export function todoItemsFromProps(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.description !== "string" || item.description.trim() === "") return [];
    if (typeof item.done !== "boolean" || !Array.isArray(item.tags)) return [];
    if (item.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) return [];
    return [{
      description: item.description,
      done: item.done,
      tags: [...new Set(item.tags as string[])],
    }];
  });
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
