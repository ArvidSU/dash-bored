import { describe, expect, test } from "bun:test";
import {
  filterTodos,
  migrateTodoItems,
  sortTodos,
  todoItemsFromProps,
  todoTags,
} from "../../src/renderer/lib/todo";

describe("dashboard YAML todo state", () => {
  test("reads only complete todo values from component props", () => {
    expect(todoItemsFromProps([
      { description: "Review dashboard YAML", done: false, tags: ["docs", "docs"] },
      { description: "Ship it", done: true, tags: [] },
      { description: "Missing tags", done: false },
      { description: "", done: false, tags: [] },
    ])).toMatchObject([
      { id: expect.any(String), description: "Review dashboard YAML", done: false, tags: ["docs"] },
      { id: expect.any(String), description: "Ship it", done: true, tags: [] },
    ]);
  });

  test("migrates missing and duplicate IDs while retaining existing unique IDs", () => {
    let next = 0;
    const migrated = migrateTodoItems([
      { id: "keep", description: "First", done: false, tags: [] },
      { description: "Legacy", done: false, tags: [] },
      { id: "keep", description: "Duplicate", done: true, tags: [] },
    ], () => `new-${++next}`);
    expect(migrated.changed).toBe(true);
    expect(migrated.items.map((item) => item.id)).toEqual(["keep", "new-1", "new-2"]);
  });

  test("sorts incomplete items first while preserving order within each status", () => {
    const items = [
      { id: "done-1", description: "done one", done: true, tags: [] },
      { id: "open-1", description: "open one", done: false, tags: [] },
      { id: "done-2", description: "done two", done: true, tags: [] },
      { id: "open-2", description: "open two", done: false, tags: [] },
    ];
    expect(sortTodos(items).map((item) => item.description)).toEqual([
      "open one",
      "open two",
      "done one",
      "done two",
    ]);
  });

  test("filters by exact tag and returns sorted tag options", () => {
    const items = [
      { id: "one", description: "one", done: false, tags: ["release", "docs"] },
      { id: "two", description: "two", done: true, tags: ["docs"] },
      { id: "three", description: "three", done: false, tags: [] },
    ];
    expect(filterTodos(items, "docs").map((item) => item.description)).toEqual(["one", "two"]);
    expect(todoTags(items)).toEqual(["docs", "release"]);
  });
});
