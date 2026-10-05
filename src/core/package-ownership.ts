import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { CoreError } from "./diagnostics";
import { resolveProjectLocation } from "./paths";
import { readTheme } from "./themes";
import { checkedOutCommit, git, hasLocalChanges, installPackage, packageWorkPath, repositoryRoot, withPackageStore, removeSubmodule } from "./package-store";

/** Explicit conversion only. All replacements are prepared before parent Git changes. */
export async function migratePackageOwnership(input: string): Promise<string[]> {
  const location = await resolveProjectLocation(input);
  return withPackageStore(location.configDirectory, "submodule", async (store) => {
    const legacy: Array<{checkout:string; repo:string; gitPath:string; section:string; entry:{url:string;commit:string;path:string}; stage:string; backup:string}> = [];
    const originals = new Map<string, Uint8Array>();
    const moved: typeof legacy = [];
    let completed = false;
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    try {
      for (const entry of [...Object.values(store.lock.components), ...Object.values(store.lock.themes ?? {})]) {
        const checkout = join(store.root, entry.path);
        const current = await checkedOutCommit(checkout);
        if (!current) continue;
        const common = await realpath(resolve(checkout, await git(checkout,["rev-parse","--git-common-dir"])));
        if (common.startsWith(join(await realpath(dirname(checkout)),".git") + sep)) continue;
        const repo = await repositoryRoot(store.root);
        const gitPath = relative(repo, checkout).split(sep).join("/");
        if (current !== entry.commit.toLowerCase() || await git(repo,["status","--porcelain","--",gitPath,".gitmodules"]) || await hasLocalChanges(checkout)) {
          throw new CoreError("PACKAGE_MIGRATION_DIRTY", `Commit or save staged changes and local edits to ${gitPath} and .gitmodules, and restore the recorded revision inside the existing package before ownership migration.`);
        }
        const records = await git(repo,["config","-f",".gitmodules","--get-regexp","^submodule\\..*\\.path$"]);
        const record = records.split("\n").find(line => line.slice(line.indexOf(" ")+1) === gitPath);
        if (!record) throw new CoreError("PACKAGE_LEGACY_OWNERSHIP", `No parent submodule registration for ${gitPath}; refusing to replace it.`);
        const section = record.slice(0,record.indexOf(" ")).replace(/\.path$/,"");
        const registeredUrl = await git(repo,["config","-f",".gitmodules","--get",`${section}.url`]);
        const activeUrl = await git(repo,["config","--get",`${section}.url`]).catch(()=>registeredUrl);
        if (registeredUrl !== entry.url || activeUrl !== entry.url) throw new CoreError("PACKAGE_MIGRATION_DIRTY", `Git URL metadata differs from the pin for ${gitPath}; resolve it before migration.`);
        for (const path of [join(repo,".gitmodules"), resolve(repo,await git(repo,["rev-parse","--git-path","index"])), resolve(repo,await git(repo,["rev-parse","--git-path","config"]))]) {
          if (!originals.has(path)) originals.set(path,await readFile(path));
        }
        legacy.push({checkout,repo,gitPath,section,entry,stage:packageWorkPath(store,"stage"),backup:packageWorkPath(store,"remove")});
      }
      // Availability and validation failures happen before replacing any checkout.
      for (const item of legacy) {
        await git(store.root,["clone","--no-checkout","--",item.entry.url,item.stage]);
        await git(item.stage,["checkout","--detach",item.entry.commit]);
        if (item.entry.path.startsWith("themes/")) await readTheme(item.stage);
      }
      for (const [path,bytes] of originals) {
        if (hash(await readFile(path)) !== hash(bytes)) throw new CoreError("PACKAGE_MIGRATION_CHANGED","Parent Git metadata changed during preparation; retry after it settles.");
      }
      for (const item of legacy) {
        if (await checkedOutCommit(item.checkout) !== item.entry.commit.toLowerCase() || await hasLocalChanges(item.checkout)) {
          throw new CoreError("PACKAGE_MIGRATION_CHANGED", `Package ${item.gitPath} changed during preparation; save its edits before retrying.`);
        }
      }
      for (const item of legacy) {
        await rename(item.checkout,item.backup);
        moved.push(item);
        await installPackage(store,{url:item.entry.url,commit:item.entry.commit,checkout:item.checkout,preparedStage:item.stage,commitLock:async()=>{}});
        await git(item.repo,["rm","--cached","--",item.gitPath]);
        await git(item.repo,["config","-f",join(item.repo,".gitmodules"),"--remove-section",item.section]);
        await git(item.repo,["add","--",".gitmodules"]);
        await git(item.repo,["config","--remove-section",item.section]).catch(()=>undefined);
      }
      completed = true;
      return legacy.map(item=>item.entry.path);
    } catch(error) {
      for (const item of [...moved].reverse()) {
        await removeSubmodule(store,item.checkout,{force:true}).catch(()=>undefined);
        await rm(item.checkout,{recursive:true,force:true});
        await rename(item.backup,item.checkout);
      }
      if (moved.length) for (const [path,bytes] of originals) await writeFile(path,bytes);
      throw error;
    } finally {
      for (const item of legacy) {
        await rm(item.stage,{recursive:true,force:true});
        // If rollback itself fails, retain the original checkout for recovery.
        if (completed) await rm(item.backup,{recursive:true,force:true});
      }
    }
  });
}
