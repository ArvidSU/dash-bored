import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDashBoredSkill } from "../../src/cli/install-skill";
import { DASH_BORED_SKILL_FILES, skillContentHash } from "../../src/cli/skill-payload";
import { installDashBoredCli } from "../../src/cli/install-cli";
import { updateInstalledTools } from "../../src/main/installed-tools";
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

test("CLI refreshes its managed old target, including a dangling target, and rejects replaced links", async () => {
  const project = await root();
  const oldSource = join(project, "old-cli");
  const newSource = join(project, "new-cli");
  await executable(oldSource);
  await executable(newSource);
  const targetDirectory = join(project, "bin");
  const prior = await installDashBoredCli({ sourcePath: oldSource, targetDirectory });
  await rm(oldSource);
  await expect(installDashBoredCli({ sourcePath: newSource, targetDirectory, check: true })).rejects.toThrow("stale");
  expect(await readlink(prior.targetPath)).toBe(oldSource);
  expect((await installDashBoredCli({ sourcePath: newSource, targetDirectory })).updated).toBeTrue();
  expect(await readlink(prior.targetPath)).toBe(newSource);
  expect((await installDashBoredCli({ sourcePath: newSource, targetDirectory, check: true })).updated).toBeFalse();
  await rm(prior.targetPath);
  await symlink(join(project, "unrelated-tool"), prior.targetPath);
  await expect(installDashBoredCli({ sourcePath: newSource, targetDirectory })).rejects.toThrow("existing CLI link");
  expect(await readlink(prior.targetPath)).toBe(join(project, "unrelated-tool"));
});

test("startup refreshes installed global and project skills and CLI, reports conflicts, and skips absent installs", async () => {
  const home = await root();
  const project = await root();
  const absentProject = await root();
  await olderSkill(home);
  const prior = await olderSkill(project);
  await writeFile(join(prior.skillPath, "SKILL.md"), "local customization\n");
  const oldSource = join(home, "old-cli");
  const newSource = join(home, "new-cli");
  await executable(oldSource);
  await executable(newSource);
  await installDashBoredCli({ sourcePath: oldSource, targetDirectory: join(home, ".local/bin") });
  const results = await updateInstalledTools({ homeDirectory: home, projectRoots: [project, absentProject], cliPath: newSource });
  expect(results.filter((result) => result.code === "INSTALLED_TOOL_UPDATED")).toHaveLength(2);
  expect(results.filter((result) => result.code === "INSTALLED_TOOL_UPDATE_CONFLICT")).toHaveLength(1);
  expect(await readFile(join(prior.skillPath, "SKILL.md"), "utf8")).toBe("local customization\n");
  expect(await Bun.file(join(absentProject, ".agents/skills/dash-bored/SKILL.md")).exists()).toBeFalse();
  const emptyHome = await root();
  expect(await updateInstalledTools({ homeDirectory: emptyHome, cliPath: newSource })).toEqual([]);
  expect(await Bun.file(join(emptyHome, ".local/bin/dash-bored")).exists()).toBeFalse();
});
