import { describe, expect, test } from "bun:test";
import { attentionArguments, buildAttentionActions, loadAttentionAnimation, type AttentionRequest } from "../../src/renderer/lib/attention";
import { rankActions } from "../../src/renderer/lib/actions";
import { builtinAnimation, type AnimationManifest } from "../../src/shared/animations";
import type { ComponentActionOption, ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";

const linked: ResolvedComponentNode = {
  id: "linked", component: "./components/external/core/status", props: { label: "Linked" }, source: "external",
  sourceConfigPath: "/project/.dash-bored/ops/dash-bored.yaml",
};
const backlog: ResolvedComponentNode = { id: "backlog", component: "./components/external/core/list", props: { title: "Backlog" }, source: "external" };
const tree: ResolvedComponentNode = {
  id: "root", component: "./components/external/core/group", props: {}, source: "external",
  children: { axis: "vertical", first: { node: backlog }, second: { node: linked } },
};
const custom: AnimationManifest = { schemaVersion: 1, id: "nudge", name: "Nudge", duration: 400, keyframes: [{ x: 0 }, { x: 4 }, { x: 0 }] };
const snapshot = {
  tree,
  config: { schemaVersion: 4, name: "Project", attentionAnimation: "./animations/nudge", root: { component: "./x" } },
  animationCatalog: [
    { reference: "builtin:bounce", name: "Bounce", manifest: builtinAnimation("builtin:bounce")! },
    { reference: "./animations/nudge", name: "Nudge", manifest: custom },
    { reference: "./animations/broken", name: "./animations/broken", error: "Invalid animation.yaml" },
  ],
} as ProjectSnapshot;

describe("attention actions", () => {
  test("address every node by stable ID behind one chooser", async () => {
    const calls: [string, AttentionRequest, string | undefined][] = [];
    const actions = buildAttentionActions(snapshot, async (nodeId, request, caller) => { calls.push([nodeId, request, caller]); });
    expect(actions.map(({ id }) => id)).toEqual(["project:attention", "attention:root", "attention:backlog", "attention:linked"]);
    expect(rankActions(actions, "").map(({ id }) => id)).toEqual(["project:attention"]);

    const [chooser] = actions;
    // The dashboard default leads; broken packages are not offered.
    expect((chooser!.choices?.[1]?.options as ComponentActionOption[]).map(({ value, label }) => [value, label])).toEqual([
      ["./animations/nudge", "Nudge (default)"], ["builtin:bounce", "Bounce"],
    ]);
    await chooser!.run({ node: "backlog", animation: "builtin:bounce" });
    await actions[2]!.run({}, { message: " Tests failed ", item: "t-1" }, "root");
    expect(calls).toEqual([
      ["backlog", { animation: "builtin:bounce" }, undefined],
      ["backlog", { message: "Tests failed", item: "t-1" }, "root"],
    ]);
    expect(() => chooser!.run({ node: "gone" })).toThrow("Choose an available component");
  });

  test("refuse arguments outside the declared shape", () => {
    expect(attentionArguments(undefined)).toEqual({});
    expect(() => attentionArguments({ animation: "shake" })).toThrow("attention accepts only");
    expect(() => attentionArguments({ message: "x".repeat(201) })).toThrow("attention accepts only");
    expect(() => attentionArguments({ scroll: true })).toThrow("attention accepts only");
  });

  test("resolve explicit animations in the caller's bundle and fall back from a broken default", async () => {
    const reads: [string, string | undefined][] = [];
    const read = async (reference: string, configPath?: string) => {
      reads.push([reference, configPath]);
      if (reference === "./animations/nudge") return custom;
      throw new Error(`${reference}: animation not found.`);
    };
    expect(await loadAttentionAnimation(snapshot, "builtin:shake", undefined, read)).toEqual(builtinAnimation("builtin:shake")!);
    await expect(loadAttentionAnimation(snapshot, "builtin:spin", undefined, read)).rejects.toThrow("not a built-in animation");
    expect(await loadAttentionAnimation(snapshot, "./animations/nudge", "linked", read)).toEqual(custom);
    expect(await loadAttentionAnimation(snapshot, undefined, undefined, read)).toEqual(custom);
    await expect(loadAttentionAnimation(snapshot, "./animations/gone", "backlog", read)).rejects.toThrow("animation not found");
    const brokenDefault = { ...snapshot, config: { ...snapshot.config!, attentionAnimation: "./animations/gone" } };
    expect(await loadAttentionAnimation(brokenDefault, undefined, undefined, read)).toEqual(builtinAnimation("builtin:bounce")!);
    expect(reads).toEqual([
      ["./animations/nudge", "/project/.dash-bored/ops/dash-bored.yaml"],
      ["./animations/nudge", undefined],
      ["./animations/gone", undefined],
      ["./animations/gone", undefined],
    ]);
  });
});
