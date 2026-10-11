import { describe, expect, test } from "bun:test";
import {
  addPaletteRecent,
  PALETTE_RECENT_HISTORY_LIMIT,
  PaletteRecentsStore,
  paletteRecentsStorageKey,
  parsePaletteRecents,
} from "../../src/renderer/lib/palette-recents";

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("palette recents", () => {
  test("moves a repeated run to the front and caps the history", () => {
    let recents = addPaletteRecent([], { actionId: "reload" });
    recents = addPaletteRecent(recents, { actionId: "project:focus", selections: { node: "tests" } });
    recents = addPaletteRecent(recents, { actionId: "project:focus", selections: { node: "docs" } });
    recents = addPaletteRecent(recents, { actionId: "reload", selections: {} });
    expect(recents).toEqual([
      { actionId: "reload" },
      { actionId: "project:focus", selections: { node: "docs" } },
      { actionId: "project:focus", selections: { node: "tests" } },
    ]);
    for (let index = 0; index < PALETTE_RECENT_HISTORY_LIMIT + 5; index += 1) {
      recents = addPaletteRecent(recents, { actionId: `run-${index}` });
    }
    expect(recents).toHaveLength(PALETTE_RECENT_HISTORY_LIMIT);
    expect(recents[0]).toEqual({ actionId: `run-${PALETTE_RECENT_HISTORY_LIMIT + 4}` });
  });

  test("parses stored history defensively", () => {
    expect(parsePaletteRecents(null)).toEqual([]);
    expect(parsePaletteRecents("not json")).toEqual([]);
    expect(parsePaletteRecents(JSON.stringify({ actionId: "reload" }))).toEqual([]);
    expect(parsePaletteRecents(JSON.stringify([
      { actionId: "reload" },
      { actionId: "" },
      "settings",
      { actionId: "theme", selections: { theme: "ocean", mode: 3 } },
      { actionId: "reload" },
    ]))).toEqual([
      { actionId: "reload" },
      { actionId: "theme", selections: { theme: "ocean" } },
    ]);
  });

  test("keeps one persisted history per dashboard and forgets removed dashboards", () => {
    const storage = memoryStorage();
    const store = new PaletteRecentsStore(() => storage);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.record("/a/dash-bored.yaml", { actionId: "process:dev" });
    store.record("/b/dash-bored.yaml", { actionId: "app:reload" });
    store.record(null, { actionId: "app:show-settings" });
    expect(store.get("/a/dash-bored.yaml")).toEqual([{ actionId: "process:dev" }]);
    expect(store.get("/b/dash-bored.yaml")).toEqual([{ actionId: "app:reload" }]);
    expect(store.get(null)).toEqual([]);
    expect(store.get("/a/dash-bored.yaml")).toBe(store.get("/a/dash-bored.yaml"));
    expect(notifications).toBe(2);

    const reloaded = new PaletteRecentsStore(() => storage);
    expect(reloaded.get("/a/dash-bored.yaml")).toEqual([{ actionId: "process:dev" }]);

    store.forget("/a/dash-bored.yaml");
    expect(store.get("/a/dash-bored.yaml")).toEqual([]);
    expect(storage.values.has(paletteRecentsStorageKey("/a/dash-bored.yaml"))).toBe(false);
    expect(storage.values.has(paletteRecentsStorageKey("/b/dash-bored.yaml"))).toBe(true);
  });

  test("keeps the session history when storage is unavailable", () => {
    const store = new PaletteRecentsStore(() => ({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    }));
    store.record("/a/dash-bored.yaml", { actionId: "process:dev" });
    expect(store.get("/a/dash-bored.yaml")).toEqual([{ actionId: "process:dev" }]);
  });
});
