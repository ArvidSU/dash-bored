import { afterEach, expect, test } from "bun:test";
import { cp, chmod, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDashBoredSkill } from "../../src/cli/install-skill";
import { DASH_BORED_SKILL_FILES, skillContentHash } from "../../src/cli/skill-payload";
import { retireManagedCliLink } from "../../src/main/retire-cli-link";
import { repairInstalledTools, updateInstalledTools } from "../../src/main/installed-tools";
import { APP_VERSION } from "../../src/shared/app-metadata";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dash-bored-tool-updates-")));
  cleanup.push(path);
  return path;
}
async function olderSkill(project: string) {
  const installed = await installDashBoredSkill(project);
  const receiptPath = join(installed.skillPath, "skill-version.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.skillVersion = "0.0.0";
  receipt.files["SKILL.md"] = skillContentHash("previous shipped skill\n");
  await writeFile(join(installed.skillPath, "SKILL.md"), "previous shipped skill\n");
  await writeFile(receiptPath, JSON.stringify(receipt));
  return installed;
}
async function executable(path: string) {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

test("skill updates owned older files and receipt, then becomes idempotent", async () => {
  const project = await root();
  const prior = await olderSkill(project);
  await expect(installDashBoredSkill(project, { check: true })).rejects.toThrow("stale");
  expect(await readFile(join(prior.skillPath, "SKILL.md"), "utf8")).toBe("previous shipped skill\n");
  const result = await installDashBoredSkill(project);
  expect(result.updated).toContain("SKILL.md");
  expect(JSON.parse(await readFile(join(result.skillPath, "skill-version.json"), "utf8")).skillVersion).toBe(APP_VERSION);
  expect(await readFile(join(result.skillPath, "SKILL.md"), "utf8")).toBe(DASH_BORED_SKILL_FILES["SKILL.md"]);
  expect((await installDashBoredSkill(project, { check: true })).updated).toEqual([]);
});

test("modified skill preflight prevents all updates and preserves the receipt", async () => {
  const project = await root();
  const prior = await olderSkill(project);
  const receipt = await readFile(join(prior.skillPath, "skill-version.json"), "utf8");
  await writeFile(join(prior.skillPath, "references/components.md"), "user edits\n");
  await expect(installDashBoredSkill(project)).rejects.toThrow("modified");
  expect(await readFile(join(prior.skillPath, "SKILL.md"), "utf8")).toBe("previous shipped skill\n");
  expect(await readFile(join(prior.skillPath, "references/components.md"), "utf8")).toBe("user edits\n");
  expect(await readFile(join(prior.skillPath, "skill-version.json"), "utf8")).toBe(receipt);
});

test("legacy matching skill can adopt ownership but unrecognized legacy contents are preserved", async () => {
  const project = await root();
  const prior = await installDashBoredSkill(project);
  await rm(join(prior.skillPath, "skill-version.json"));
  expect((await installDashBoredSkill(project)).created).toContain("skill-version.json");
  await rm(join(prior.skillPath, "skill-version.json"));
  await writeFile(join(prior.skillPath, "SKILL.md"), "unknown legacy or custom content\n");
  await expect(installDashBoredSkill(project)).rejects.toThrow("modified");
  expect(await readFile(join(prior.skillPath, "SKILL.md"), "utf8")).toBe("unknown legacy or custom content\n");
});

test("skill checks are read-only and a replaced support symlink cannot write outside installation", async () => {
  const project = await root();
  await expect(installDashBoredSkill(project, { check: true })).rejects.toThrow("Missing");
  expect(await Bun.file(join(project, ".agents/skills/dash-bored/SKILL.md")).exists()).toBeFalse();
  const prior = await installDashBoredSkill(project);
  await rm(join(prior.skillPath, "references"), { recursive: true });
  const external = await root();
  await symlink(external, join(prior.skillPath, "references"));
  await expect(installDashBoredSkill(project)).rejects.toThrow("symbolic link");
  expect(await Bun.file(join(external, "components.md")).exists()).toBeFalse();
});

test("skill install writes an executable agent-tool launcher and restores its mode", async () => {
  const project = await root();
  const installed = await installDashBoredSkill(project);
  const launcher = join(installed.skillPath, "scripts", "dash-bored");
  expect((await stat(launcher)).mode & 0o777).toBe(0o755);
  await chmod(launcher, 0o644);
  await expect(installDashBoredSkill(project, { check: true })).rejects.toThrow("not executable");
  await installDashBoredSkill(project);
  expect((await stat(launcher)).mode & 0o111).not.toBe(0);
});

test("startup retires only a receipt-owned CLI link into an app bundle", async () => {
  const home = await root();
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const bundled = join(home, "dash-bored.app", "Contents", "Resources", "app", "tools", "dash-bored");
  await mkdir(join(bundled, ".."), { recursive: true });
  await executable(bundled);
  await symlink(bundled, join(bin, "dash-bored"));
  await writeFile(join(bin, ".dash-bored-cli.json"), JSON.stringify({ sourcePath: bundled, version: "0.3.2" }));
  expect(await retireManagedCliLink(home)).toBeTrue();
  expect(await Bun.file(join(bin, ".dash-bored-cli.json")).exists()).toBeFalse();
  await expect(readlink(join(bin, "dash-bored"))).rejects.toThrow();

  const unrelated = join(home, "my-dash-bored");
  await executable(unrelated);
  await symlink(unrelated, join(bin, "dash-bored"));
  await writeFile(join(bin, ".dash-bored-cli.json"), JSON.stringify({ sourcePath: bundled, version: "0.3.2" }));
  expect(await retireManagedCliLink(home)).toBeFalse();
  expect(await readlink(join(bin, "dash-bored"))).toBe(unrelated);
});

test("startup refreshes installed global and project skills, reports conflicts, and skips absent installs", async () => {
  const home = await root();
  const project = await root();
  const absentProject = await root();
  await olderSkill(home);
  const prior = await olderSkill(project);
  await writeFile(join(prior.skillPath, "SKILL.md"), "local customization\n");
  const results = await updateInstalledTools({ homeDirectory: home, projectRoots: [project, absentProject] });
  expect(results.filter((result) => result.code === "INSTALLED_TOOL_UPDATE_CONFLICT")).toHaveLength(1);
  expect(results.some((result) => result.code === "INSTALLED_TOOL_UPDATED")).toBeFalse();
  expect(await readFile(join(prior.skillPath, "SKILL.md"), "utf8")).toBe("local customization\n");
  expect(await Bun.file(join(absentProject, ".agents/skills/dash-bored/SKILL.md")).exists()).toBeFalse();
  const emptyHome = await root();
  expect(await updateInstalledTools({ homeDirectory: emptyHome })).toEqual([]);
});

async function legacySkill(project: string, version = "0.2.2") {
  const skillPath = join(project, ".agents/skills/dash-bored");
  await cp(join(import.meta.dirname, `../fixtures/skill-v${version}`), skillPath, { recursive: true });
  return skillPath;
}

test("startup adopts complete pristine v0.2.2 skills and subsequent checks are clean", async () => {
  const home = await root();
  const project = await root();
  await legacySkill(home);
  await legacySkill(project);
  const diagnostics = await updateInstalledTools({ homeDirectory: home, projectRoots: [project] });
  expect(diagnostics).toEqual([]);
  for (const directory of [home, project]) {
    expect((await installDashBoredSkill(directory, { check: true })).updated).toEqual([]);
  }
});

test("an edited legacy payload cannot claim ownership of any old file", async () => {
  const project = await root();
  const skillPath = await legacySkill(project);
  const original = await readFile(join(skillPath, "SKILL.md"), "utf8");
  await writeFile(join(skillPath, "references/components.md"), "my local guidance");
  await expect(installDashBoredSkill(project)).rejects.toThrow("modified");
  expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toBe(original);
  expect(await readFile(join(skillPath, "references/components.md"), "utf8")).toBe("my local guidance");
  expect(await Bun.file(join(skillPath, "skill-version.json")).exists()).toBeFalse();
});

test("partial legacy skills cannot be silently adopted", async () => {
  const project = await root();
  const skillPath = await legacySkill(project);
  const original = await readFile(join(skillPath, "SKILL.md"), "utf8");
  await rm(join(skillPath, "agents/openai.yaml"));
  await expect(installDashBoredSkill(project)).rejects.toThrow("modified");
  expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toBe(original);
  expect(await Bun.file(join(skillPath, "skill-version.json")).exists()).toBeFalse();
});

test("pristine v0.2.3 payload upgrades, but mixing release files is a conflict", async () => {
  const project = await root();
  await legacySkill(project, "0.2.3");
  await installDashBoredSkill(project);
  expect((await installDashBoredSkill(project, { check: true })).updated).toEqual([]);
  const mixed = await root();
  const skillPath = await legacySkill(mixed, "0.2.3");
  const older = await readFile(join(import.meta.dirname, "../fixtures/skill-v0.2.2/SKILL.md"));
  await writeFile(join(skillPath, "SKILL.md"), older);
  await expect(installDashBoredSkill(mixed)).rejects.toThrow("modified");
  expect(await readFile(join(skillPath, "SKILL.md"))).toEqual(older);
  expect(await Bun.file(join(skillPath, "skill-version.json")).exists()).toBeFalse();
});

test("explicit repair trashes conflicting installs before reinstalling the current tools", async () => {
  const home = await root();
  const priorSkill = await installDashBoredSkill(home);
  await writeFile(join(priorSkill.skillPath, "SKILL.md"), "custom global guidance\n");
  const trash = join(home, "trash");
  await mkdir(trash);
  const trashed: string[] = [];
  let trashIndex = 0;
  const diagnostics = await repairInstalledTools({
    homeDirectory: home,
    repairGlobalSkill: true,
    moveToTrash: async (path) => {
      trashed.push(path);
      await rename(path, join(trash, String(trashIndex++)));
      return true;
    },
  });

  expect(diagnostics).toEqual([]);
  expect(trashed).toEqual(expect.arrayContaining([
    priorSkill.skillPath,
    priorSkill.claudeSkillPath,
  ]));
  expect(await readFile(join(priorSkill.skillPath, "SKILL.md"), "utf8")).toBe(DASH_BORED_SKILL_FILES["SKILL.md"]);
  const recoveredSkill = await readFile(join(trash, "1", "SKILL.md"), "utf8");
  expect(recoveredSkill).toBe("custom global guidance\n");
});
