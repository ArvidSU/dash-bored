import { describe, expect, test } from "bun:test";
import { migrateTodoItems } from "../../src/migrations/todo-ids";

describe("legacy todo ID backfill", () => {
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
});
