/**
 * Legacy migration, scheduled for deletion at dashboard schema v4: todo props
 * written before todos carried stable IDs. After v4 every todo has a unique
 * `id` in YAML and this file goes away with its callers in
 * `renderer/lib/todo.ts` and the todo-list component.
 *
 * Node-free on purpose: the renderer bundles it.
 */
import { createTodoId, type TodoItem } from "../shared/todo";

/** Adds stable IDs to legacy todo props while preserving unique IDs already in YAML. */
export function migrateTodoItems(
  value: unknown,
  createId: () => string = createTodoId,
): { items: TodoItem[]; changed: boolean } {
  let changed = false;
  const ids = new Set<string>();
  if (!Array.isArray(value)) return { items: [], changed: false };
  const items = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.description !== "string" || item.description.trim() === "") return [];
    if (typeof item.done !== "boolean" || !Array.isArray(item.tags)) return [];
    if (item.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) return [];
    let id = typeof item.id === "string" && item.id.trim() !== "" ? item.id : "";
    if (id === "" || ids.has(id)) {
      id = createId();
      changed = true;
    }
    ids.add(id);
    return [{
      id,
      description: item.description,
      done: item.done,
      tags: [...new Set(item.tags as string[])],
    }];
  });
  return { items, changed };
}
