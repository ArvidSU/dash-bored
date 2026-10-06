import { describe, expect, test } from "bun:test";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import { buildRevealActions, buildSelectionActions, revealItemArgument } from "../../src/renderer/lib/selection-actions";
import { getCoreManifest as getBuiltinManifest } from "../../scripts/core-package-fixture";
import { rankActions, rankPaletteEntries } from "../../src/renderer/lib/actions";

const child: ResolvedComponentNode = { id: "overview", component: "./components/external/core/status", props: { title: "Overview" }, source: "external" };
const other: ResolvedComponentNode = { id: "details", component: "./components/external/core/markdown", props: { title: "Details" }, source: "external" };
const container: ResolvedComponentNode = {
  id: "panels", component: "./components/external/core/group", props: {}, source: "external",
  manifest: { schemaVersion: 3, apiVersion: "1.0.0", id: "group", name: "Panels", description: "", entry: "./index", propsSchema: {}, children: { min: 0, presentation: { type: "managed" }, select: "single" } },
  children: [{ node: child }, { node: other }],
};
const snapshot = { tree: container } as ProjectSnapshot;

describe("selection and reveal actions", () => {
  test("offers one active selection action per managed child", () => {
    const actions = buildSelectionActions(snapshot, {}, () => {});
    expect(actions.map(({ id, active }) => [id, active])).toEqual([
      ["project:select", undefined], ["select:panels/overview", true], ["select:panels/details", false],
    ]);
  });

  test("lists unselected panels under one chooser and keeps direct selection actions out of the main list", async () => {
    const selected: string[] = [];
    const actions = buildSelectionActions(snapshot, {}, (containerId, childId) => { selected.push(`${containerId}/${childId}`); });
    expect(actions.slice(1).every(({ parentActionId }) => parentActionId === "project:select")).toBeTrue();
    expect(actions[0]!.choices?.[0]?.options).toEqual([
      { value: "select:panels/details", label: "Details", description: "details · Dashboard" },
    ]);
    expect(rankActions(actions, "").map(({ id }) => id)).toEqual(["project:select"]);
    await actions[0]!.run({ panel: "select:panels/details" });
    expect(selected).toEqual(["panels/details"]);
    expect(() => actions[0]!.run({ panel: "select:panels/overview" })).toThrow("Choose an available panel");
  });

  test("labels selection actions with the edge's panel label before the node's own name", () => {
    const labelled = { ...container, children: [{ node: child, metadata: { label: "Health" } }, { node: other }] };
    const actions = buildSelectionActions({ ...snapshot, tree: labelled }, {}, () => {});
    expect(actions.map(({ label }) => label)).toEqual(["Select panel", "Select Health", "Select Details"]);
  });

  test("ships a generic selection container and honors its YAML default child", () => {
    expect(getBuiltinManifest("./components/external/core/selection")?.children).toMatchObject({
      presentation: { type: "managed" }, select: "single",
    });
    const configured = { ...container, props: { defaultChild: "details" } };
    const actions = buildSelectionActions({ ...snapshot, tree: configured }, {}, () => {});
    expect(actions.map(({ id, active }) => [id, active])).toEqual([
      ["project:select", undefined], ["select:panels/overview", false], ["select:panels/details", true],
    ]);
  });

  test("reveal actions address every node by stable ID", () => {
    const actions = buildRevealActions(snapshot, () => {});
    expect(actions.map(({ id, active }) => [id, active])).toEqual([
      ["project:reveal", undefined],
      ["reveal:panels", undefined], ["reveal:overview", undefined], ["reveal:details", undefined],
    ]);
  });

  test("groups reveal targets under one searchable chooser and awaits the selected target", async () => {
    const calls: string[] = [];
    const actions = buildRevealActions(snapshot, async (nodeId) => {
      await Promise.resolve();
      calls.push(nodeId);
    });
    expect(rankActions(actions, "reveal").map(({ id }) => id)).toEqual(["project:reveal"]);
    expect(rankActions(actions, "details").map(({ id }) => id)).toEqual([]);
    expect(rankPaletteEntries(actions, "details").map((entry) =>
      entry.kind === "option" ? `${entry.action.id} › ${entry.option.value}` : entry.action.id,
    )).toEqual(["project:reveal › details"]);
    expect(rankActions(actions, "", new Set(["reveal:details"])).map(({ id }) => id)).toEqual(["project:reveal"]);
    expect(rankActions(actions, "reveal", new Set(), true).map(({ id }) => id)).toContain("reveal:details");
    expect(actions[0]!.choices?.[0]?.options).toEqual([
      { value: "panels", label: "Dashboard", description: "panels" },
      { value: "overview", label: "Overview", description: "overview" },
      { value: "details", label: "Details", description: "details" },
    ]);
    await actions[0]!.run({ node: "details" });
    expect(calls).toEqual(["details"]);
    expect(() => actions[0]!.run({ node: "missing" })).toThrow("Choose an available component to reveal.");
    expect(buildRevealActions(null, () => {})).toEqual([]);
  });

  test("reveal passes an optional item ID and refuses other arguments", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const actions = buildRevealActions(snapshot, (nodeId, itemId) => { calls.push([nodeId, itemId]); });
    const reveal = actions.find(({ id }) => id === "reveal:details")!;
    await reveal.run(undefined, {});
    await reveal.run(undefined, { item: "todo-7" });
    expect(calls).toEqual([["details", undefined], ["details", "todo-7"]]);
    expect(() => revealItemArgument({ item: "" })).toThrow("reveal accepts only");
    expect(() => revealItemArgument({ item: "a", extra: 1 })).toThrow("reveal accepts only");
  });
});
