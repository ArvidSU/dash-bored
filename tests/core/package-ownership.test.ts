import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { addComponent, removeComponent, syncComponents } from "../../src/core/external-components";
import { migratePackageOwnership } from "../../src/core/package-ownership";
import { restoreMissingPackages } from "../../src/core/package-restore";
import { inspectProject } from "../../src/core/project";
import { readPackageStore, installPackage, removePackage, checkedOutCommit, submoduleLocation } from "../../src/core/package-store";
import { createProject, temporaryDirectory, removeTemporaryDirectory } from "./helpers";
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory)); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {cwd, encoding:"utf8", stdio:["ignore","pipe","pipe"]}).trim();
async function fixture(parentGit = false) {
 const root = await temporaryDirectory(); cleanup.push(root);
 const source = join(root,"source"); await mkdir(source);
 git(source,"init","-q"); git(source,"config","user.name","Test"); git(source,"config","user.email","test@example.com"); git(source,"config","commit.gpgsign","false");
 await writeFile(join(source,"component.yaml"),stringify({schemaVersion:3, apiVersion: "1.0.0",id:"fixture",name:"Fixture",description:"Fixture",entry:"./index.tsx",propsSchema:{type:"object"}}));
 await writeFile(join(source,"index.tsx"),"export default () => null;\n"); git(source,"add","."); git(source,"commit","-qm","fixture");
 const project = join(root,"project"); await createProject(project,{schemaVersion:4,name:"Packages",root:{component:"./components/external/fixture"}});
 if(parentGit) {git(project,"init","-q");git(project,"config","user.name","Test");git(project,"config","user.email","test@example.com");git(project,"config","commit.gpgsign","false");git(project,"add",".");git(project,"commit","-qm","initial");}
 return {root,source,project,bundle:join(project,".dash-bored"),url:`file://${source}`,commit:git(source,"rev-parse","HEAD")};
}
async function parentMetadata(project:string) {
 return Promise.all([".git/index",".git/config",".gitmodules"].map(path=>readFile(join(project,path)).catch(()=>null)));
}
test("private package operations preserve the parent index, config and staged content",async()=>{
 const f=await fixture(true); await writeFile(join(f.project,"staged.txt"),"user work");git(f.project,"add","staged.txt");
 const before=await parentMetadata(f.project);
 await addComponent(f.project,f.url,{name:"fixture"});
 expect(await inspectProject(f.project)).toMatchObject({ok:true});
 expect(git(f.project,"check-ignore",".dash-bored/components/external/fixture/index.tsx")).toContain("components/external");
 await syncComponents(f.project); await removeComponent(f.project,"fixture");
 expect(await parentMetadata(f.project)).toEqual(before);
 expect(git(f.project,"diff","--cached","--name-only")).toBe("staged.txt");
});
test("plain bundles reconstruct private Git and exact pins without identity or commits",async()=>{
 const f=await fixture(); await addComponent(f.project,f.url,{name:"fixture"});
 const pins=await readFile(join(f.bundle,"dash-bored-lock.yaml"));
 await rm(join(f.bundle,"components","external"),{recursive:true});
 expect((await inspectProject(f.project)).ok).toBe(false);
 expect(await readdir(f.bundle)).not.toContain(".package-operation.lock");
 expect(await restoreMissingPackages(f.project)).toEqual([]);
 expect(await checkedOutCommit(join(f.bundle,"components","external","fixture"))).toBe(f.commit);
 expect(await readFile(join(f.bundle,"dash-bored-lock.yaml"))).toEqual(pins);
 const code = await readFile(join(f.bundle,"components","external","fixture","index.tsx"));
 await rm(join(f.bundle,"components","external",".git"),{recursive:true});
 expect(await restoreMissingPackages(f.project)).toEqual([]);
 expect(await checkedOutCommit(join(f.bundle,"components","external","fixture"))).toBe(f.commit);
 expect(await readFile(join(f.bundle,"components","external","fixture","index.tsx"))).toEqual(code);
});
test("restoration leaves dirty or mismatched existing checkouts untouched and offline pins intact",async()=>{
 const f=await fixture();await addComponent(f.project,f.url,{name:"fixture"});
 const checkout=join(f.bundle,"components","external","fixture");await writeFile(join(checkout,"local.txt"),"local");
 expect(await restoreMissingPackages(f.project)).toEqual([]);
 await expect(syncComponents(f.project)).rejects.toThrow(/local changes/);
 await expect(removeComponent(f.project,"fixture")).rejects.toThrow(/local changes/);
 await rm(join(f.bundle,"components","external"),{recursive:true});await rm(f.source,{recursive:true});
 const pins=await readFile(join(f.bundle,"dash-bored-lock.yaml"));
 expect(await restoreMissingPackages(f.project)).toMatchObject([{code:"PACKAGE_RESTORE_FAILED"}]);
 expect(await readFile(join(f.bundle,"dash-bored-lock.yaml"))).toEqual(pins);
 expect((await readdir(f.bundle)).filter(name=>name.startsWith(".package-"))).toEqual([]);
});
test("failed lock publication rolls install and removal registrations back",async()=>{
 const f=await fixture();const store=await readPackageStore(f.bundle,"submodule");const checkout=join(f.bundle,"components","external","fixture");
 const fail=async()=>{throw new Error("lock publication failed");};
 await expect(installPackage(store,{url:f.url,commit:f.commit,checkout,commitLock:fail})).rejects.toThrow("lock publication failed");
 expect(await checkedOutCommit(checkout)).toBe(null);
 await addComponent(f.project,f.url,{name:"fixture"});
 const before=await readFile(join(f.bundle,"components","external",".git","index"));
 await expect(removePackage(store,checkout,fail)).rejects.toThrow("lock publication failed");
 expect(await checkedOutCommit(checkout)).toBe(f.commit);
 expect(await readFile(join(f.bundle,"components","external",".git","index"))).toEqual(before);
});
test("failed submodule registration removes partial checkouts and preserves pins", async () => {
 const f = await fixture();
 const store = await readPackageStore(f.bundle, "submodule");
 const checkout = join(f.bundle, "components", "external", "fixture");
 const { repo } = await submoduleLocation(store, checkout);
 const pins = await readFile(store.lockPath);
 await writeFile(join(repo, ".git", "index.lock"), "busy");
 await expect(installPackage(store, { url: f.url, commit: f.commit, checkout, commitLock: async () => {} })).rejects.toThrow();
 expect(await checkedOutCommit(checkout)).toBe(null);
 expect((await readdir(repo)).filter(name => name === "fixture")).toEqual([]);
 expect((await readdir(f.bundle)).filter(name => name.startsWith(".package-"))).toEqual([]);
 expect(await readFile(store.lockPath)).toEqual(pins);
 expect(await readFile(join(repo, ".git", "index.lock"), "utf8")).toBe("busy");
});
test("opening preserves a mismatched revision and inspection directs explicit Sync", async () => {
 const f = await fixture(); await addComponent(f.project, f.url, { name: "fixture" });
 await writeFile(join(f.source, "index.tsx"), "export default () => <p>new revision</p>;\n");
 git(f.source, "add", "."); git(f.source, "commit", "-qm", "new revision");
 const next = git(f.source, "rev-parse", "HEAD");
 const checkout = join(f.bundle, "components", "external", "fixture");
 git(checkout, "fetch", f.url, next); git(checkout, "checkout", "--detach", next);
 const pins = await readFile(join(f.bundle, "dash-bored-lock.yaml"));
 expect(await restoreMissingPackages(f.project)).toEqual([]);
 expect(await checkedOutCommit(checkout)).toBe(next);
 const inspected = await inspectProject(f.project);
 expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "PACKAGE_PIN_MISMATCH", message: expect.stringMatching(/Sync/) }));
 expect(await readFile(join(f.bundle, "dash-bored-lock.yaml"))).toEqual(pins);
 await syncComponents(f.project);
 expect(await checkedOutCommit(checkout)).toBe(f.commit);
});
async function legacy() {
 const f=await fixture(true);const path=".dash-bored/components/external/fixture";
 git(f.project,"submodule","add",f.url,path);
 await writeFile(join(f.bundle,"dash-bored-lock.yaml"),stringify({lockfileVersion:1,components:{fixture:{url:f.url,commit:f.commit,path:"components/external/fixture"}},themes:{}}));
 git(f.project,"add",".");git(f.project,"commit","-qm","legacy");return f;
}
test("ownership conversion is explicit and preserves pins and unrelated staging",async()=>{
 const f=await legacy();const lock=await readFile(join(f.bundle,"dash-bored-lock.yaml"));
 await expect(syncComponents(f.project)).rejects.toThrow(/parent repository/);
 await writeFile(join(f.project,"staged.txt"),"keep");git(f.project,"add","staged.txt");
 expect(await migratePackageOwnership(f.project)).toEqual(["components/external/fixture"]);
 expect(await readFile(join(f.bundle,"dash-bored-lock.yaml"))).toEqual(lock);
 expect(git(f.project,"diff","--cached","--name-only")).toContain("staged.txt");
 await syncComponents(f.project);expect(await checkedOutCommit(join(f.bundle,"components","external","fixture"))).toBe(f.commit);
});
test("ownership conversion refuses staged registrations and package edits before mutation",async()=>{
 const f=await legacy();await writeFile(join(f.project,".gitmodules"),(await readFile(join(f.project,".gitmodules"),"utf8"))+"# staged user edit\n");git(f.project,"add",".gitmodules");
 const before=await parentMetadata(f.project);await expect(migratePackageOwnership(f.project)).rejects.toThrow(/staged changes/);
 expect(await parentMetadata(f.project)).toEqual(before);
 git(f.project,"reset","--hard","HEAD");await writeFile(join(f.bundle,"components","external","fixture","local.txt"),"keep");
 await expect(migratePackageOwnership(f.project)).rejects.toThrow(/local edits/);
 expect(await readFile(join(f.bundle,"components","external","fixture","local.txt"),"utf8")).toBe("keep");
});
