import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync } from "node:fs";

test("the production renderer builds without component checkouts or test fixtures", async () => {
  const project=resolve(import.meta.dirname,"../..");
  const scratch=await mkdtemp(join(tmpdir(),"dash-independent-build-"));
  try {
    await cp(join(project,"src"),join(scratch,"src"),{recursive:true});
    await cp(join(project,"vite.config.ts"),join(scratch,"vite.config.ts"));
    await cp(join(project,"package.json"),join(scratch,"package.json"));
    await symlink(join(project,"node_modules"),join(scratch,"node_modules"));
    await symlink(join(project,".hutch"),join(scratch,".hutch"));
    const logPath=join(scratch,"build.log");const log=openSync(logPath,"w");
    let child:Bun.Subprocess;
    try {child=Bun.spawn(["bun","./node_modules/vite/bin/vite.js","build"],{cwd:scratch,env:{...process.env,DASH_BORED_FIXTURE:"0"},stdin:"ignore",stdout:log,stderr:log});}
    finally {closeSync(log);}
    const result=await child.exited;
    expect(result,await readFile(logPath,"utf8")).toBe(0);
    expect(await Bun.file(join(scratch,"dist","index.html")).exists()).toBeTrue();
    expect(await Bun.file(join(scratch,".cottontail-tmp","core-fixture.json")).exists()).toBeFalse();
    expect(await Bun.file(join(scratch,".dash-bored","components","external","core","package.yaml")).exists()).toBeFalse();
  } finally {await rm(scratch,{recursive:true,force:true});}
},30_000);
