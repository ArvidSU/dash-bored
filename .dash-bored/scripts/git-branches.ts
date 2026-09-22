import { gitBranchesCommand, parseGitBranchesOutput } from "../components/git-branches/git-branches";
import type { GitBranch, GitBranchesSnapshot } from "../components/git-branches/git-branches";

export interface BranchListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  state: string;
  name: string;
}

function branchDetail(branch: GitBranch): string {
  const parts = [branch.commit, branch.age];
  parts.push(branch.upstream ? `tracks ${branch.upstream}` : "no upstream");
  parts.push(branch.work === null ? "work count unavailable" : `${branch.work} commits on base`);
  if (branch.ahead !== null) parts.push(`${branch.ahead} ahead`);
  if (branch.behind !== null) parts.push(`${branch.behind} behind`);
  return parts.join(" · ");
}

export function branchListItems(snapshot: GitBranchesSnapshot): BranchListItem[] {
  return snapshot.branches.map((branch) => {
    const current = branch.name === snapshot.current;
    const tags = ["branch"];
    if (current) tags.push("current");
    if (snapshot.dirty && current) tags.push("dirty");
    return {
      id: `branch:${branch.name}`,
      title: branch.name,
      detail: branchDetail(branch),
      tags,
      state: current ? (snapshot.dirty ? "warning" : "current") : "branch",
      name: branch.name,
    };
  });
}

export function gitBranchesListJson(snapshot: GitBranchesSnapshot): string {
  return JSON.stringify(branchListItems(snapshot));
}

if (import.meta.main) {
  const cwd = process.env.DASH_BORED_CWD || ".";
  const env = { ...process.env };
  if (process.env.DASH_BORED_BASE_BRANCH) env.DASH_BORED_BASE_BRANCH = process.env.DASH_BORED_BASE_BRANCH;
  const result = Bun.spawnSync(["sh", "-c", gitBranchesCommand()], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(result.stderr).trim() || "Git could not inspect this project.\n");
    process.exit(result.exitCode || 1);
  }
  const snapshot = parseGitBranchesOutput(new TextDecoder().decode(result.stdout));
  process.stdout.write(`${gitBranchesListJson(snapshot)}\n`);
}
