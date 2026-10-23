import { referenceLocations } from "../../src/shared/reference-locations";
import { expect, test } from "bun:test";
import { validateNode, validateWatch } from "../../src/core/tree-validate";
import { selectedChildId } from "../../src/renderer/lib/component-view-state";
import { watchSource } from "../../src/shared/watches";
import { COMPONENT_API_VERSION, COMPONENT_RUNTIME_EXPORTS } from "../../src/shared/component-api";
import type { ComponentManifest, ResolvedComponentNode } from "../../src/shared/contracts";

const manifest: ComponentManifest = {
  schemaVersion: 3, apiVersion: "2.0.0", id: "unrelated-author-view", name: "View", description: "View", entry: "./index.tsx", propsSchema: {},
  children: { min: 0, presentation: { type: "managed" }, select: "single", defaultChildProp: "initialPanel" },
  resources: { observation: { sourceProp: "observedData", kind: "list" } },
};
const node: ResolvedComponentNode = {
  id: "container", component: "./components/unrelated-author-view", source: "local", manifest,
  props: { defaultChild: "b", initialPanel: "b", source: { shell: "wrong-command" }, observedData: { shell: "correct-command" } },
  children: ["a", "b"].map((id) => ({ node: { id, component: "./components/leaf", props: {}, source: "local" } })),
};

test("selection reads only the manifest-bound default prop", () => {
  expect(selectedChildId(node, {})).toBe("b");
  const noBinding = { ...node, manifest: { ...manifest, children: { ...manifest.children!, defaultChildProp: undefined } } };
  expect(selectedChildId(noBinding, {})).toBe("a");
  expect(selectedChildId(node, { container: "a" })).toBe("a");
  const badProps = { ...node.props, initialPanel: "missing" };
  expect(validateNode(manifest, node, badProps, node.children as never, "root").map((item) => item.code)).toContain("COMPONENT_DEFAULT_CHILD_MISSING");
});

test("observations use an explicit source binding and reject mismatched watch families", () => {
  expect(watchSource(node.props)).toHaveProperty("error");
  expect(watchSource(node.props, manifest.resources!.observation)).toEqual({ source: { kind: "shell", value: "correct-command" } });
  const watched = { ...node, watch: { on: ["added"] as const } };
  expect(validateWatch(watched as never, "root", { manifest })).toEqual([]);
  expect(validateWatch({ ...watched, watch: { on: ["error"] } } as never, "root", { manifest }).some((item) => item.message.includes("declares list"))).toBeTrue();
  expect(validateWatch(watched as never, "root").some((item) => item.message.includes("does not declare"))).toBeTrue();
});

test("API2 removes the app-owned terminal surface", () => {
  expect(COMPONENT_API_VERSION).toBe("2.0.0");
  expect(COMPONENT_RUNTIME_EXPORTS as readonly string[]).not.toContain("TerminalSurface");
});


test("declared reference paths inspect only owned data, including explicit prototype-named keys", () => {
  const inherited = Object.create({ nested: { action: "focus:decoy" } }) as Record<string, unknown>;
  expect(referenceLocations(inherited, "nested.action")).toEqual([]);
  expect(referenceLocations({}, "constructor.prototype.action")).toEqual([]);
  const explicit = JSON.parse('{"nested":{"__proto__":{"action":"focus:actual"}}}') as Record<string, unknown>;
  expect(referenceLocations(explicit, "nested.__proto__.action").map(({ parent, key }) => parent[key])).toEqual(["focus:actual"]);
});
