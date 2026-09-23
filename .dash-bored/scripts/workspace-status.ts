import { emit, runOrExit } from "./lib/run";

export interface WorkspaceStatus {
  state: "healthy" | "warning" | "error";
  detail: string;
}

/** Summarize `git status --porcelain=v2 --branch` as a status tile. */
export function workspaceStatus(porcelain: string): WorkspaceStatus {
  let branch = "(detached HEAD)";
  let ahead = 0;
  let behind = 0;
  let upstream = false;
  let changed = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.upstream ")) upstream = true;
    else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (line.startsWith("u ")) conflicts += 1;
    else if (line.startsWith("? ")) untracked += 1;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) changed += 1;
  }
  const parts = [branch];
  parts.push(changed || untracked ? `${changed} changed, ${untracked} untracked` : "clean");
  if (upstream) parts.push(ahead || behind ? `↑${ahead} ↓${behind}` : "in sync");
  else parts.push("no upstream");
  return {
    state: conflicts ? "error" : changed || untracked || behind ? "warning" : "healthy",
    detail: conflicts ? `${conflicts} conflicted · ${parts.join(" · ")}` : parts.join(" · "),
  };
}

if (import.meta.main) {
  emit(workspaceStatus(runOrExit(["git", "status", "--porcelain=v2", "--branch"])));
}
