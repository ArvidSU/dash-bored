import { emit, runOrExit } from "./lib/run";

export interface ChangeListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  state: string;
  path: string;
  prompt: string;
}

const CODES: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflict",
  T: "type changed",
};

/** Parse `git status --porcelain=v1 -z` into list items. */
export function changeListItems(porcelain: string): ChangeListItem[] {
  const entries = porcelain.split("\0");
  const items: ChangeListItem[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const staged = entry[0]!;
    const unstaged = entry[1]!;
    const path = entry.slice(3);
    // Renames and copies carry their source path as the next entry.
    if (staged === "R" || staged === "C") index += 1;
    const tags: string[] = [];
    let state: string;
    if (staged === "?") {
      tags.push("untracked");
      state = "untracked";
    } else if (staged === "U" || unstaged === "U" || (staged === "A" && unstaged === "A") || (staged === "D" && unstaged === "D")) {
      tags.push("conflict");
      state = "conflict";
    } else {
      if (staged !== " ") tags.push("staged");
      if (unstaged !== " ") tags.push("unstaged");
      state = CODES[staged !== " " ? staged : unstaged] ?? "changed";
    }
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : "(root)";
    tags.push(top);
    items.push({
      id: `change:${path}`,
      title: path,
      detail: `${state}${tags.includes("staged") && tags.includes("unstaged") ? " · partially staged" : ""}`,
      tags,
      state,
      path,
      prompt: `Review the uncommitted changes in ${path} in this repository. Point out correctness risks and missing tests; do not edit files.`,
    });
  }
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

if (import.meta.main) {
  emit(changeListItems(runOrExit(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"])));
}
