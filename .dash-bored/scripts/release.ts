import { readFileSync, writeFileSync } from "node:fs";
import { compareVersions } from "../../src/shared/updates";
import { emit, runOrExit } from "./lib/run";

/**
 * Release controls for the project dashboard's Release tab.
 *
 *   status          status tile: can package.json's version be cut right now?
 *   versions        list of next patch/minor/major versions after the latest tag
 *   set [version]   write package.json's version (prompts when none is given)
 *   cut [--confirm vX.Y.Z]
 *                   docs/release-qa.md "Cut a release": guard, QA, commit the
 *                   bump, push main, wait for CI, push the tag, and check the
 *                   draft prerelease. Publishing stays a manual GitHub step.
 */

const RELEASE_BRANCH = "main";
const REMOTE = "origin";
const DRAFT_ASSETS: Array<[string, (name: string) => boolean]> = [
  ["DMG", (name) => name.endsWith(".dmg")],
  ["app archive", (name) => name.endsWith(".app.tar.zst")],
  ["update metadata", (name) => name.endsWith("update.json")],
  ["MIGRATIONS.md", (name) => name === "MIGRATIONS.md"],
  ["SHA256SUMS.txt", (name) => name === "SHA256SUMS.txt"],
];

export interface GitState {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; conflict: boolean }>;
}

export interface ReleaseState {
  git: GitState;
  /** package.json's version in the working tree. */
  version: string;
  /** Highest `v*` release tag, or null before the first release. */
  latestTag: string | null;
  /** `v<version>` is already tagged. */
  tagExists: boolean;
  /** package.json matches HEAD apart from its version field. */
  versionOnlyBump: boolean;
}

export interface ReleaseStatus {
  state: "unknown" | "healthy" | "warning" | "error";
  detail: string;
}

export interface VersionItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  /** Only the version package.json already holds has a state. */
  state?: "healthy";
  version: string;
}

export function isReleaseVersion(version: string): boolean {
  try {
    compareVersions(version, version);
    return true;
  } catch {
    return false;
  }
}

/** Parse `git status --porcelain=v2 --branch --untracked-files=all`. */
export function parseGitStatus(porcelain: string): GitState {
  const state: GitState = { branch: "(detached HEAD)", upstream: null, ahead: 0, behind: 0, changes: [] };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) state.branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice("# branch.upstream ".length);
    else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      state.ahead = Number(match?.[1] ?? 0);
      state.behind = Number(match?.[2] ?? 0);
    } else if (line.startsWith("1 ")) state.changes.push({ path: line.split(" ").slice(8).join(" "), conflict: false });
    else if (line.startsWith("2 ")) state.changes.push({ path: line.split(" ").slice(9).join(" ").split("\t")[0]!, conflict: false });
    else if (line.startsWith("u ")) state.changes.push({ path: line.split(" ").slice(10).join(" "), conflict: true });
    else if (line.startsWith("? ")) state.changes.push({ path: line.slice(2), conflict: false });
  }
  return state;
}

export function latestReleaseTag(tags: string[]): string | null {
  const versions = tags.filter((tag) => tag.startsWith("v") && isReleaseVersion(tag.slice(1)));
  versions.sort((left, right) => compareVersions(left.slice(1), right.slice(1)));
  return versions.at(-1) ?? null;
}

/** Replace package.json's top-level version without reformatting the file. */
export function setPackageVersion(text: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  if (!pattern.test(text)) throw new Error("package.json has no version field.");
  const updated = text.replace(pattern, `$1${version}$2`);
  if ((JSON.parse(updated) as { version?: unknown }).version !== version) throw new Error("Could not rewrite package.json's version field.");
  return updated;
}

/** Everything that must change before `cut` may run; empty means ready. */
export function releaseBlockers(state: ReleaseState): string[] {
  const { git } = state;
  const blockers: string[] = [];
  const conflicts = git.changes.filter((change) => change.conflict).length;
  if (conflicts) blockers.push(`${conflicts} merge conflict${conflicts === 1 ? "" : "s"}`);
  if (git.branch !== RELEASE_BRANCH) blockers.push(`on ${git.branch}, not ${RELEASE_BRANCH}`);
  else if (git.upstream !== `${REMOTE}/${RELEASE_BRANCH}`) blockers.push(`${RELEASE_BRANCH} does not track ${REMOTE}/${RELEASE_BRANCH}`);
  if (git.ahead) blockers.push(`${git.ahead} unpushed commit${git.ahead === 1 ? "" : "s"}`);
  if (git.behind) blockers.push(`${git.behind} commit${git.behind === 1 ? "" : "s"} behind ${REMOTE}/${RELEASE_BRANCH}`);
  const others = git.changes.filter((change) => !change.conflict && change.path !== "package.json");
  if (others.length) {
    const shown = others.slice(0, 3).map((change) => change.path).join(", ");
    blockers.push(`uncommitted: ${shown}${others.length > 3 ? ` +${others.length - 3} more` : ""}`);
  }
  if (!state.versionOnlyBump) blockers.push("package.json has uncommitted changes besides its version");
  if (!isReleaseVersion(state.version)) blockers.push(`package.json version ${JSON.stringify(state.version)} is not MAJOR.MINOR.PATCH`);
  else if (state.tagExists) blockers.push(`v${state.version} is already tagged`);
  else if (state.latestTag && compareVersions(state.version, state.latestTag.slice(1)) <= 0) blockers.push(`${state.version} is not newer than ${state.latestTag}`);
  return blockers;
}

export function readinessStatus(state: ReleaseState): ReleaseStatus {
  const blockers = releaseBlockers(state);
  if (!blockers.length) {
    const bump = state.git.changes.some((change) => change.path === "package.json") ? "commits the version bump" : "version committed";
    return { state: "healthy", detail: `Ready to cut v${state.version} · ${bump}` };
  }
  if (state.git.changes.some((change) => change.conflict)) return { state: "error", detail: blockers.join(" · ") };
  // Right after a release, the only thing to do is choose the next version.
  if (blockers.length === 1 && state.tagExists) return { state: "unknown", detail: `v${state.version} is released · choose the next version` };
  return { state: "warning", detail: blockers.join(" · ") };
}

export function versionCandidates(latestTag: string | null, current: string): VersionItem[] {
  const base = latestTag?.slice(1) ?? "0.0.0";
  const [major, minor, patch] = base.split("-")[0]!.split(".").map(Number) as [number, number, number];
  const prerelease = base.includes("-");
  const candidates: Array<[string, string]> = [
    ["patch", prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`],
    ["minor", `${major}.${minor + 1}.0`],
    ["major", `${major + 1}.0.0`],
  ];
  const newer = isReleaseVersion(current) && compareVersions(current, base) > 0;
  if (newer && !candidates.some(([, version]) => version === current)) candidates.unshift(["custom", current]);
  const after = latestTag ? `After ${latestTag}` : "First release";
  return candidates.map(([kind, version]) => ({
    id: `version:${version}`,
    title: `v${version}`,
    detail: version === current ? `${after} · set in package.json` : after,
    tags: [kind],
    ...(version === current ? { state: "healthy" as const } : {}),
    version,
  }));
}

function capture(command: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function readState(): ReleaseState {
  const git = parseGitStatus(runOrExit(["git", "status", "--porcelain=v2", "--branch", "--untracked-files=all"]));
  const working = readFileSync("package.json", "utf8");
  const version = String((JSON.parse(working) as { version?: unknown }).version ?? "");
  const head = capture(["git", "show", "HEAD:package.json"]);
  let versionOnlyBump = false;
  try {
    versionOnlyBump = head.code === 0 && setPackageVersion(head.stdout, version) === working;
  } catch {
    // An unreadable HEAD package.json is a blocker, not a crash.
  }
  const tags = runOrExit(["git", "tag", "--list", "v*"]).split("\n").filter(Boolean);
  return { git, version, latestTag: latestReleaseTag(tags), tagExists: tags.includes(`v${version}`), versionOnlyBump };
}

class ReleaseError extends Error {}

function step(title: string): void {
  process.stdout.write(`\n▸ ${title}\n`);
}

function must(command: string[], what: string): string {
  const result = capture(command);
  if (result.code !== 0) throw new ReleaseError(`${what} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  return result.stdout.trim();
}

/** Run with the terminal attached, without the app's DASH_* variables, as on the hosted runner. */
function attached(command: string[], extraEnv: Record<string, string> = {}): number {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DASH_")));
  const awake = Bun.which("caffeinate") ? ["caffeinate", "-is"] : [];
  return Bun.spawnSync([...awake, ...command], { env: { ...env, ...extraEnv }, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode;
}

async function poll<T>(what: string, attempts: number, read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (value) return value;
    await Bun.sleep(5000);
  }
  throw new ReleaseError(`Timed out waiting for ${what}.`);
}

interface WorkflowRun { databaseId: number; url: string; createdAt: string }

/** Watch the newest matching run; with `since`, ignore runs from before our push. */
async function watchWorkflow(workflow: string, filter: string[], label: string, since?: Date): Promise<WorkflowRun> {
  const earliest = since ? since.getTime() - 60_000 : 0; // tolerate clock skew
  const run = await poll(`${label} to start`, 36, () => {
    const result = capture(["gh", "run", "list", "--workflow", workflow, ...filter, "--limit", "5", "--json", "databaseId,url,createdAt"]);
    if (result.code !== 0) return null;
    return (JSON.parse(result.stdout) as WorkflowRun[]).find((candidate) => Date.parse(candidate.createdAt) >= earliest) ?? null;
  });
  process.stdout.write(`${run.url}\n`);
  attached(["gh", "run", "watch", String(run.databaseId), "--interval", "15"]);
  const conclusion = must(["gh", "run", "view", String(run.databaseId), "--json", "conclusion", "--jq", ".conclusion"], `Reading ${label}`);
  if (conclusion !== "success") throw new ReleaseError(`${label} finished with "${conclusion}". Read it with: gh run view ${run.databaseId} --log-failed`);
  return run;
}

function guard(): ReleaseState {
  const state = readState();
  const blockers = releaseBlockers(state);
  if (blockers.length) throw new ReleaseError(`Not releasing:\n  - ${blockers.join("\n  - ")}`);
  return state;
}

async function cut(args: string[]): Promise<void> {
  const confirmIndex = args.indexOf("--confirm");
  const confirmation = confirmIndex === -1 ? null : args[confirmIndex + 1] ?? "";

  step(`Checking ${RELEASE_BRANCH} against ${REMOTE}`);
  if (capture(["gh", "auth", "status"]).code !== 0) throw new ReleaseError("The GitHub CLI is not signed in; run gh auth login first.");
  must(["git", "fetch", "--quiet", "--tags", REMOTE, RELEASE_BRANCH], `Fetching ${REMOTE}`);
  const state = guard();
  const tag = `v${state.version}`;
  const existing = capture(["gh", "release", "view", tag, "--json", "tagName"]);
  if (existing.code === 0) throw new ReleaseError(`A GitHub Release already exists for ${tag}.`);
  if (!/not found/i.test(existing.stderr)) throw new ReleaseError(`Checking GitHub for a ${tag} release failed: ${existing.stderr.trim()}`);
  const head = must(["git", "rev-parse", "HEAD"], "Reading HEAD");
  const bump = state.git.changes.some((change) => change.path === "package.json");
  process.stdout.write([
    `Release ${tag} (previous ${state.latestTag ?? "none"}) from ${head.slice(0, 7)} ${must(["git", "log", "-1", "--format=%s"], "Reading HEAD")}`,
    "This will run release QA, then",
    bump ? `  - commit package.json as "chore(release): prepare ${tag}" and push ${RELEASE_BRANCH}` : `  - use ${RELEASE_BRANCH} as pushed (package.json already says ${state.version})`,
    `  - wait for CI on ${RELEASE_BRANCH}, then push the annotated tag ${tag}`,
    "  - wait for the release workflow and check the draft prerelease",
    "Publishing the draft stays a manual step on GitHub.",
    "",
  ].join("\n"));
  const typed = confirmation ?? prompt(`Type ${tag} to release:`);
  if (typed?.trim() !== tag) throw new ReleaseError("Not confirmed; nothing was changed.");

  for (const [title, command, env] of [
    ["Fast QA", ["bun", "run", "qa:fast"]],
    ["Tests as the hosted runner runs them", ["bun", "run", "test"], { CI: "true" }],
    ["Validate project dashboard", ["bun", "run", "dash-bored", "--", "validate", "."]],
    ["Validate dogfood dashboard", ["bun", "run", "dash-bored", "--", "validate", ".dash-bored/dogfood"]],
    ["Verify the published core package pin", ["bun", "run", "packages:verify-published"]],
  ] as Array<[string, string[], Record<string, string>?]>) {
    step(title);
    if (attached(command, env) !== 0) throw new ReleaseError(`${title} failed; nothing was committed, pushed, or tagged.`);
  }

  step("Re-checking the working tree after QA");
  must(["git", "fetch", "--quiet", "--tags", REMOTE, RELEASE_BRANCH], `Fetching ${REMOTE}`);
  const after = guard();
  if (after.version !== state.version || must(["git", "rev-parse", "HEAD"], "Reading HEAD") !== head) {
    throw new ReleaseError("HEAD or package.json changed while QA ran; start the release again.");
  }

  let pushedAt: Date | undefined;
  if (bump) {
    step(`Committing and pushing the ${tag} version bump`);
    must(["git", "commit", "--quiet", "--only", "-m", `chore(release): prepare ${tag}`, "--", "package.json"], "Committing package.json");
    pushedAt = new Date();
    if (attached(["git", "push", REMOTE, `HEAD:refs/heads/${RELEASE_BRANCH}`]) !== 0) {
      throw new ReleaseError(`Pushing ${RELEASE_BRANCH} failed; the bump is committed locally only. Pull, then cut again.`);
    }
  }
  const sha = must(["git", "rev-parse", "HEAD"], "Reading HEAD");

  step(`Waiting for CI on ${sha.slice(0, 7)}`);
  await watchWorkflow("ci.yml", ["--commit", sha, "--event", "push"], "CI", pushedAt);

  step(`Tagging ${tag}`);
  must(["git", "tag", "-a", tag, "-m", `dash-bored ${tag}`, sha], `Creating ${tag}`);
  const taggedAt = new Date();
  if (attached(["git", "push", REMOTE, `refs/tags/${tag}`]) !== 0) {
    throw new ReleaseError(`Pushing ${tag} failed; the tag exists locally only. Retry with: git push ${REMOTE} refs/tags/${tag}`);
  }

  step("Waiting for the release workflow");
  await watchWorkflow("release.yml", ["--commit", sha, "--event", "push"], "The release workflow", taggedAt);
  const release = JSON.parse(must(["gh", "release", "view", tag, "--json", "isDraft,url,assets"], `Reading the ${tag} release`)) as { isDraft: boolean; url: string; assets: Array<{ name: string }> };
  const missing = DRAFT_ASSETS.filter(([, matches]) => !release.assets.some((asset) => matches(asset.name))).map(([name]) => name);
  if (!release.isDraft) throw new ReleaseError(`${tag} is no longer a draft: ${release.url}`);
  if (missing.length) throw new ReleaseError(`The ${tag} draft is missing: ${missing.join(", ")}. ${release.url}`);
  process.stdout.write(`\n✓ Draft prerelease ${tag} is ready with all assets. Review and publish it yourself:\n${release.url}\n`);
}

function set(requested: string | undefined): void {
  const state = readState();
  const candidates = versionCandidates(state.latestTag, state.version);
  const suggested = candidates.find((item) => item.version === state.version) ?? candidates[0]!;
  const options = candidates.map((item) => item.version).join(", ");
  const version = (requested || prompt(`Next version after ${state.latestTag ?? "nothing"} (${options}):`, suggested.version) || "").trim().replace(/^v/, "");
  if (!isReleaseVersion(version)) throw new ReleaseError(`${JSON.stringify(version)} is not MAJOR.MINOR.PATCH (optionally -prerelease).`);
  if (state.latestTag && compareVersions(version, state.latestTag.slice(1)) <= 0) throw new ReleaseError(`${version} is not newer than ${state.latestTag}.`);
  if (version === state.version) process.stdout.write(`package.json already says ${version}.\n`);
  else {
    writeFileSync("package.json", setPackageVersion(readFileSync("package.json", "utf8"), version));
    process.stdout.write(`package.json: ${state.version} → ${version}\n`);
  }
  const blockers = releaseBlockers(readState());
  process.stdout.write(blockers.length ? `Before cutting v${version}:\n  - ${blockers.join("\n  - ")}\n` : `Ready to cut v${version}.\n`);
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "status") emit(readinessStatus(readState()));
    else if (mode === "versions") {
      const state = readState();
      emit(versionCandidates(state.latestTag, state.version));
    } else if (mode === "set") set(args[0] || process.env.DASH_ITEM_VERSION);
    else if (mode === "cut") await cut(args);
    else throw new ReleaseError("Usage: release.ts status | versions | set [version] | cut [--confirm vX.Y.Z]");
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    process.stderr.write(`\n✗ ${error.message}\n`);
    process.exit(1);
  }
}
