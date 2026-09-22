import { describe, expect, test } from "bun:test";
import { filterListItems, parseDashboardList, sortListItems } from "../../src/renderer/lib/list-data";

describe("source list shape and presentation", () => {
  test("requires source-owned non-empty unique string IDs and titles", () => {
    const parsed = parseDashboardList([
      { id: "one", title: "First" },
      { id: "one", title: "Duplicate" },
      { title: "Missing ID" },
      { id: 4, title: "Wrong ID type" },
      { id: "no-title", title: "" },
      null,
    ]);
    expect(parsed.items).toEqual([{ id: "one", title: "First" }]);
    expect(parsed.diagnostics.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.diagnostics[0]?.message).toContain("duplicated");
    expect(parsed.diagnostics[1]?.message).toContain("id must be");
    expect(parsed.diagnostics[3]?.message).toContain("title must be");
  });

  test("reports invalid optional field types and non-array roots", () => {
    expect(parseDashboardList({ id: "one", title: "One" }).diagnostics[0]?.message)
      .toContain("JSON array");
    const parsed = parseDashboardList([{ id: "one", title: "One", detail: 3, tags: "a", state: false, done: "yes" }]);
    expect(parsed.items).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(4);
  });

  test("filters exact tags and sorts completed items after open items stably", () => {
    const items = [
      { id: "closed-1", title: "Closed first", state: "done", tags: ["docs"] },
      { id: "open-1", title: "Open one", state: "running", tags: ["docs", "release"] },
      { id: "closed-2", title: "Closed second", done: true, tags: ["docs"] },
      { id: "open-2", title: "Open two", tags: ["release"] },
    ];
    expect(filterListItems(items, "docs").map((item) => item.id)).toEqual(["closed-1", "open-1", "closed-2"]);
    expect(sortListItems(items, "open-first").map((item) => item.id)).toEqual([
      "open-1", "open-2", "closed-1", "closed-2",
    ]);
    expect(sortListItems(items, "source-order").map((item) => item.id)).toEqual([
      "closed-1", "open-1", "closed-2", "open-2",
    ]);
  });
});
