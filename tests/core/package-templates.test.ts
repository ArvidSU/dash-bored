import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadPackageTemplates } from "../../src/core/package-templates";
import { instantiateTemplateNode } from "../../src/renderer/composition/templates";
import type { ComponentCatalogItem, ComponentNode, DashboardConfig } from "../../src/shared/contracts";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dash-package-template-"));cleanup.push(root);
  const directory = join(root,"package");await mkdir(directory);
  await writeFile(join(directory,"package.yaml"), stringify({schemaVersion:1,templates:[{id:"sample",name:"Sample",path:"sample.yaml"}]}));
  await writeFile(join(directory,"sample.yaml"), stringify({id:"example",component:"${package}/arbitrary",props:{heading:"${projectName}",literal:"${item.id}"}}));
  return {root,directory};
}
test("an unrelated package provides templates with explicit safe interpolation", async()=>{
  const {directory}=await fixture();
  const templates=await loadPackageTemplates(directory,"./components/vendor-collection",{projectName:"A: quoted project"});
  expect(templates[0]!.root).toMatchObject({component:"./components/vendor-collection/arbitrary",props:{heading:"A: quoted project",literal:"${item.id}"}});
});
test("template files cannot escape the package through paths or symlinks",async()=>{
  const {root,directory}=await fixture();
  await writeFile(join(root,"outside.yaml"), stringify({component:"./components/outside"}));
  await symlink(join(root,"outside.yaml"),join(directory,"sample.yaml.link"));
  for(const path of ["../outside.yaml","sample.yaml.link"]){
    await writeFile(join(directory,"package.yaml"),stringify({schemaVersion:1,templates:[{id:"escape",name:"Escape",path}]}));
    await expect(loadPackageTemplates(directory,"./components/example")).rejects.toThrow();
  }
});
test("arbitrary template IDs, selection props, actions and process references remap on repeated insertion",()=>{
  const selector="./components/vendor/deck", control="./components/vendor/actuator";
  const catalog:ComponentCatalogItem[]=[
    {reference:selector,source:"local",available:true,diagnostics:[],manifest:{schemaVersion:3,apiVersion:"2.0.0",id:"vendor/deck",name:"Deck",description:"Deck",entry:"./index.tsx",propsSchema:{},children:{min:0,presentation:{type:"managed"},select:"single",defaultChildProp:"initialPanel"}}},
    {reference:control,source:"local",available:true,diagnostics:[],manifest:{schemaVersion:3,apiVersion:"2.0.0",id:"vendor/actuator",name:"Actuator",description:"Actuator",entry:"./index.tsx",propsSchema:{},references:{"operations.*.invoke":{resource:"action"},"observedTask":{resource:"process"}}}},
  ];
  const root:ComponentNode={id:"deck",component:selector,props:{initialPanel:"card"},children:[{node:{id:"card",component:control,props:{observedTask:"card",operations:[{invoke:{run:"select:deck/card",with:{preserve:"literal"}}}]}}}]};
  const config:DashboardConfig={schemaVersion:4,name:"Collision",root};
  const inserted=instantiateTemplateNode({id:"unrelated",name:"Unrelated",reference:"vendor#unrelated",root},config,catalog);
  expect(inserted.id).toBe("deck-2");expect(inserted.props!.initialPanel).toBe("card-2");
  if(!Array.isArray(inserted.children))throw Error("Expected managed children");
  expect(inserted.children[0]!.node.props).toEqual({observedTask:"card-2",operations:[{invoke:{run:"select:deck-2/card-2",with:{preserve:"literal"}}}]});
  expect(root.props!.initialPanel).toBe("card");
});
