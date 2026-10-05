import { describe, expect, test } from "bun:test";
import type { ResolvedComponentNode } from "../../src/shared/contracts";
import {
  childSelectionsStorageKey,
  collapsedComponentsStorageKey,
} from "../../src/renderer/lib/component-view-state";
import {
  componentHeightOverridesStorageKey,
} from "../../src/renderer/lib/component-height";
import { DashboardViewStateStore } from "../../src/renderer/lib/dashboard-view-state";
import { layoutBranchKey } from "../../src/renderer/lib/component-children";
import { splitRatioOverridesStorageKey } from "../../src/renderer/render/split-layout";
import { virtualRootStorageKey } from "../../src/renderer/lib/virtual-root";

const path = "/projects/one/.dash-bored/dash-bored.yaml";
const siblingPath = "/projects/two/.dash-bored/dash-bored.yaml";

function node(
  id: string,
  children?: ResolvedComponentNode["children"],
  select = false,
): ResolvedComponentNode {
  return {
    id,
    component: id === "root" ? "./components/external/core/group" : "./components/external/core/card",
    props: {},
    source: "external",
    ...(children === undefined ? {} : { children }),
    ...(select ? {
      manifest: {
        schemaVersion: 2,
        id,
        name: id,
        description: "",
        entry: `builtin:${id}`,
        propsSchema: {},
        children: { min: 0, presentation: { type: "managed" }, select: "single" },
      },
    } : id === "root" ? {
      manifest: {
        schemaVersion: 2,
        id,
        name: id,
        description: "",
        entry: `builtin:${id}`,
        renderMode: "layout",
        propsSchema: {},
      },
    } : {
      manifest: {
        schemaVersion: 2,
        id,
        name: id,
        description: "",
        entry: `builtin:${id}`,
        propsSchema: {},
      },
    }),
  };
}

const tree = node("root", {
  axis: "horizontal",
  ratio: 0.5,
  first: { node: node("surface") },
  second: { node: node("selection", [
    { node: node("child-a") },
    { node: node("child-b") },
  ], true) },
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("keyed dashboard view state", () => {
  test("synchronously decodes legacy keys and prunes the snapshot against the tree", () => {
    const storage = memoryStorage({
      [virtualRootStorageKey(path)]: "child-a",
      [collapsedComponentsStorageKey(path)]: JSON.stringify(["root", "surface", "selection", "child-a", "gone"]),
      [splitRatioOverridesStorageKey(path)]: JSON.stringify({
        [layoutBranchKey("root", [])]: { ratio: 0.6, defaultRatio: 0.5 },
        gone: { ratio: 0.7, defaultRatio: 0.5 },
      }),
      [componentHeightOverridesStorageKey(path)]: JSON.stringify({ surface: 180, root: 220, gone: 140 }),
      [childSelectionsStorageKey(path)]: JSON.stringify({ selection: "child-b", other: "missing" }),
    });
    const store = new DashboardViewStateStore(() => storage);
    const state = store.getSnapshot(path, tree);

    expect(state.virtualRoot).toBe("child-a");
    expect([...state.collapsed]).toEqual(["surface"]);
    expect(Object.keys(state.splits)).toEqual([layoutBranchKey("root", [])]);
    expect(state.heights).toEqual({ surface: 180 });
    expect(state.selections).toEqual({ selection: "child-b" });
    expect(store.getSnapshot(path, tree)).toBe(state);
    store.reconcile(path, tree);
    expect(JSON.parse(storage.values.get(collapsedComponentsStorageKey(path)) ?? "null")).toEqual(["surface"]);
    expect(JSON.parse(storage.values.get(componentHeightOverridesStorageKey(path)) ?? "null")).toEqual({ surface: 180 });
  });

  test("updates notify only the matching path and persist through the legacy codec", () => {
    const storage = memoryStorage();
    const store = new DashboardViewStateStore(() => storage);
    let firstNotifications = 0;
    let otherNotifications = 0;
    store.subscribe(path, () => { firstNotifications += 1; });
    store.subscribe(siblingPath, () => { otherNotifications += 1; });

    store.update(path, tree, (current) => ({ ...current, virtualRoot: "child-b" }));

    expect(firstNotifications).toBe(1);
    expect(otherNotifications).toBe(0);
    expect(storage.values.get(virtualRootStorageKey(path))).toBe("child-b");
    expect(storage.values.has(collapsedComponentsStorageKey(path))).toBe(false);
    expect(store.getSnapshot(path, tree).virtualRoot).toBe("child-b");
    expect(store.getSnapshot(siblingPath)).toMatchObject({ virtualRoot: null });
  });

  test("permanently prunes removed focus, collapse, and selection IDs", () => {
    const storage = memoryStorage({
      [virtualRootStorageKey(path)]: "child-a",
      [collapsedComponentsStorageKey(path)]: JSON.stringify(["child-a"]),
      [childSelectionsStorageKey(path)]: JSON.stringify({ selection: "child-a" }),
    });
    const store = new DashboardViewStateStore(() => storage);
    const withoutChildA = node("root", {
      axis: "horizontal",
      ratio: 0.5,
      first: { node: node("surface") },
      second: { node: node("selection", [{ node: node("child-b") }], true) },
    });

    expect(store.getSnapshot(path, withoutChildA)).toMatchObject({
      virtualRoot: null,
      selections: {},
    });
    expect(store.getSnapshot(path, withoutChildA).collapsed.has("child-a")).toBe(false);
    store.reconcile(path, withoutChildA);
    expect(storage.values.has(virtualRootStorageKey(path))).toBe(false);
    expect(JSON.parse(storage.values.get(collapsedComponentsStorageKey(path)) ?? "null")).toEqual([]);
    expect(JSON.parse(storage.values.get(childSelectionsStorageKey(path)) ?? "null")).toEqual({});

    const restored = store.getSnapshot(path, tree);
    expect(restored.virtualRoot).toBeNull();
    expect(restored.collapsed.has("child-a")).toBe(false);
    expect(restored.selections).toEqual({});
  });

  test("keeps collapse state when no focused virtual root requests expansion", () => {
    const storage = memoryStorage({
      [collapsedComponentsStorageKey(path)]: JSON.stringify(["root"]),
    });
    const store = new DashboardViewStateStore(() => storage);
    expect(store.getSnapshot(path, tree).collapsed.has("root")).toBe(true);
  });

  test("expands the focus path once, then keeps a later collapse inside the focus", () => {
    const storage = memoryStorage({
      [virtualRootStorageKey(path)]: "selection",
      [collapsedComponentsStorageKey(path)]: JSON.stringify(["selection"]),
    });
    const store = new DashboardViewStateStore(() => storage);
    expect(store.getSnapshot(path, tree).collapsed.has("selection")).toBe(false);
    store.reconcile(path, tree);

    store.update(path, tree, (current) => ({ ...current, collapsed: new Set(["selection"]) }));
    expect(store.getSnapshot(path, tree).collapsed.has("selection")).toBe(true);
    expect(JSON.parse(storage.values.get(collapsedComponentsStorageKey(path)) ?? "null")).toEqual(["selection"]);

    const reloaded = structuredClone(tree);
    expect(store.getSnapshot(path, reloaded).collapsed.has("selection")).toBe(false);
  });

  test("forget removes the keyed entry and every legacy key independently", () => {
    const storage = memoryStorage();
    const store = new DashboardViewStateStore(() => storage);
    store.update(path, tree, (current) => ({ ...current, virtualRoot: "child-b" }));
    const keys = [
      virtualRootStorageKey(path),
      collapsedComponentsStorageKey(path),
      splitRatioOverridesStorageKey(path),
      componentHeightOverridesStorageKey(path),
      childSelectionsStorageKey(path),
    ];
    let notifications = 0;
    store.subscribe(path, () => { notifications += 1; });

    store.forget(path);

    expect(notifications).toBe(1);
    expect(keys.every((key) => !storage.values.has(key))).toBe(true);
    expect(store.getSnapshot(path).virtualRoot).toBeNull();
    store.update(path, tree, (current) => ({ ...current, virtualRoot: "child-a" }));
    expect(notifications).toBe(2);
  });
});
