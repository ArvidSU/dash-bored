import { describe, expect, test } from "bun:test";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import { buildRevealActions, buildSelectionActions, revealItemArgument } from "../../src/renderer/lib/selection-actions";
import { getBuiltinManifest } from "../../src/core/builtins";
import { rankActions } from "../../src/renderer/lib/actions";

const child: ResolvedComponentNode = { id: "overview", component: "@dash-bored/status", props: { title: "Overview" }, source: "builtin" };
const other: ResolvedComponentNode = { id: "details", component: "@dash-bored/markdown", props: { title: "Details" }, source: "builtin" };
const container: ResolvedComponentNode = {
  id: "panels", component: "@dash-bored/group", props: {}, source: "builtin",
  manifest: { schemaVersion: 2, id: "group", name: "Panels", description: "", entry: "./index", propsSchema: {}, children: { min: 0, presentation: { type: "managed" }, select: "single" } },
  children: [{ node: child }, { node: other }],
};
const snapshot = { tree: container } as ProjectSnapshot;

describe("selection and reveal actions", () => {
  test("offers one active selection action per managed child", () => {
    const actions = buildSelectionActions(snapshot, {}, () => {});
    expect(actions.map(({ id, active }) => [id, active])).toEqual([
      ["select:panels/overview", true], ["select:panels/details", false],
    ]);
  });

  test("ships a generic selection container and honors its YAML default child", () => {
    expect(getBuiltinManifest("@dash-bored/selection")?.children).toMatchObject({
      presentation: { type: "managed" }, select: "single",
    });
    const configured = { ...container, props: { defaultChild: "details" } };
    const actions = buildSelectionActions({ ...snapshot, tree: configured }, {}, () => {});
    expect(actions.map(({ id, active }) => [id, active])).toEqual([
      ["select:panels/overview", false], ["select:panels/details", true],
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
    expect(rankActions(actions, "details").map(({ id }) => id)).toEqual(["project:reveal"]);
    expect(rankActions(actions, "", new Set(["reveal:details"])).map(({ id }) => id)).toEqual(["project:reveal"]);
    expect(rankActions(actions, "reveal", new Set(), true).map(({ id }) => id)).toContain("reveal:details");
    expect(actions[0]!.choices?.[0]?.options).toEqual([
      { value: "panels", label: "Dashboard", description: actions[1]!.description },
      { value: "overview", label: "Overview", description: actions[2]!.description },
      { value: "details", label: "Details", description: actions[3]!.description },
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
