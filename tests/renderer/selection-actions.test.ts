import { describe, expect, test } from "bun:test";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";
import { buildRevealActions, buildSelectionActions } from "../../src/renderer/lib/selection-actions";
import { getBuiltinManifest } from "../../src/core/builtins";

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
      ["reveal:panels", undefined], ["reveal:overview", undefined], ["reveal:details", undefined],
    ]);
  });
});
