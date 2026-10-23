import { declaredComponentLabel } from "../../src/shared/component-label";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProcessActions } from "../../src/renderer/lib/action-providers";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../src/shared/contracts";

test("application sources do not name component implementations or import their checkout", async () => {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "generated") await visit(path); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = await readFile(path, "utf8");
      expect(text, path).not.toContain("./components/external/core/");
      expect(text, path).not.toMatch(/@dash-bored\/(?:button|group|command|status|markdown|selection|todo-list)["'`]/);
      expect(text, path).not.toMatch(/(?:from|import\s*\()\s*["'][^"']*\.dash-bored\/components/);
      expect(text, path).not.toContain("props.defaultChild");
      expect(text, path).not.toContain("props.source");
      expect(text, path).not.toMatch(/props\.(?:label|title)\s*\?\?\s*props\.(?:title|label)/);
    }
  };
  await visit(resolve(import.meta.dirname, "../../src"));
});

test("process actions use an unrelated package's declared caption and command fields", () => {
  const node: ResolvedComponentNode = {id:"job",component:"./components/vendor/worker",source:"local",props:{label:"Wrong caption",command:"wrong command",caption:"Actual job",executeText:"printf ready"},manifest:{schemaVersion:3,apiVersion:"2.0.0",id:"vendor/worker",name:"Worker",description:"Worker",entry:"./index.tsx",propsSchema:{},permissions:["process:execute"],resources:{process:{commandProp:"executeText",labelProp:"caption"}}}};
  const snapshot={tree:node,trusted:true,processes:[]} as unknown as ProjectSnapshot;
  const actions=buildProcessActions(snapshot,null,{runQuickAction(){},stop(){}});
  expect(actions[0]!.label).toBe("Run Actual job");
  expect(actions[0]!.description).toBe("printf ready");
  delete node.manifest!.resources!.process!.labelProp;
  expect(buildProcessActions(snapshot,null,{runQuickAction(){},stop(){}})[0]!.label).toBe("Run job");
});

test("display captions require author-declared fields rather than conventional prop names", () => {
  const node = { props: { title: "Decoy", label: "Decoy", caption: "Actual caption" }, manifest: { labelProps: ["caption"] } } as unknown as ResolvedComponentNode;
  expect(declaredComponentLabel(node)).toBe("Actual caption");
  delete node.manifest!.labelProps;
  expect(declaredComponentLabel(node)).toBeUndefined();
});
