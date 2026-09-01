import { describe, expect, test } from "bun:test";
import {
  filterTodos,
  sortTodos,
  todoItemsFromProps,
  todoTags,
} from "../../src/renderer/todo";

describe("dashboard YAML todo state", () => {
  test("reads only complete todo values from component props", () => {
    expect(todoItemsFromProps([
      { description: "Review dashboard YAML", done: false, tags: ["docs", "docs"] },
      { description: "Ship it", done: true, tags: [] },
      { description: "Missing tags", done: false },
      { description: "", done: false, tags: [] },
    ])).toEqual([
      { description: "Review dashboard YAML", done: false, tags: ["docs"] },
      { description: "Ship it", done: true, tags: [] },
    ]);
  });

  test("sorts incomplete items first while preserving order within each status", () => {
    const items = [
      { description: "done one", done: true, tags: [] },
      { description: "open one", done: false, tags: [] },
      { description: "done two", done: true, tags: [] },
      { description: "open two", done: false, tags: [] },
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
      { description: "one", done: false, tags: ["release", "docs"] },
      { description: "two", done: true, tags: ["docs"] },
      { description: "three", done: false, tags: [] },
    ];
    expect(filterTodos(items, "docs").map((item) => item.description)).toEqual(["one", "two"]);
    expect(todoTags(items)).toEqual(["docs", "release"]);
  });
});
