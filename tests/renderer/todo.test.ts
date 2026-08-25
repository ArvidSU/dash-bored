import { describe, expect, test } from "bun:test";
import {
  filterTodos,
  parseTodoYaml,
  serializeTodoYaml,
  sortTodos,
  todoTags,
} from "../../src/renderer/todo";

describe("YAML todo state", () => {
  test("round-trips only description, done, and tags", () => {
    const items = [
      { description: "Quote \"docs\"", done: false, tags: ["docs", "release"] },
      { description: "Ship it", done: true, tags: [] },
    ];

    const source = serializeTodoYaml(items);
    expect(source).toBe(
      'todos:\n  - description: "Quote \\"docs\\""\n    done: false\n    tags: ["docs","release"]\n  - description: "Ship it"\n    done: true\n    tags: []\n',
    );
    expect(parseTodoYaml(source)).toEqual(items);
  });

  test("accepts block tag lists and defaults omitted optional fields", () => {
    expect(parseTodoYaml(`
todos:
  - description: Review YAML
    done: false
    tags:
      - docs
      - docs
  - description: "No tags"
`)).toEqual([
      { description: "Review YAML", done: false, tags: ["docs"] },
      { description: "No tags", done: false, tags: [] },
    ]);
  });

  test("rejects fields outside the small todo model and invalid status values", () => {
    expect(() => parseTodoYaml(`todos:\n  - description: Task\n    id: hidden\n`)).toThrow("unsupported field");
    expect(() => parseTodoYaml(`todos:\n  - description: Task\n    done: yes\n`)).toThrow("must be true or false");
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
