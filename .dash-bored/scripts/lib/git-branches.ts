export interface GitBranch {
  name: string;
  upstream: string | null;
  commit: string;
  age: string;
  work: number | null;
  ahead: number | null;
  behind: number | null;
}

export interface GitBranchesSnapshot {
  current: string;
  base: string | null;
  dirty: boolean;
  branches: GitBranch[];
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export function parseGitBranchesOutput(source: string): GitBranchesSnapshot {
  let current = "(detached HEAD)";
  let base: string | null = null;
  let dirty = false;
  const branches: GitBranch[] = [];

  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields[0] === "meta") {
      if (fields[1]) current = fields[1];
      base = fields[2] || null;
      dirty = fields[3] === "dirty";
      continue;
    }
    if (fields[0] !== "branch" || !fields[1]) continue;
    branches.push({
      name: fields[1],
      upstream: fields[2] || null,
      commit: fields[3] || "—",
      age: fields[4] || "unknown",
      work: parseCount(fields[5]),
      ahead: parseCount(fields[6]),
      behind: parseCount(fields[7]),
    });
  }

  return { current, base, dirty, branches };
}

export function gitBranchesCommand(): string {
  return `
set -u
git rev-parse --is-inside-work-tree >/dev/null
current=$(git branch --show-current)
if [ -z "$current" ]; then current="(detached HEAD)"; fi
base="\${DASH_BORED_BASE_BRANCH:-}"
if [ -n "$base" ] && ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then base=""; fi
if [ -z "$base" ]; then base=$(git symbolic-ref --short --quiet refs/remotes/origin/HEAD 2>/dev/null || true); fi
if [ -z "$base" ] && git rev-parse --verify --quiet main^{commit} >/dev/null; then base="main"; fi
if [ -z "$base" ] && git rev-parse --verify --quiet master^{commit} >/dev/null; then base="master"; fi
if [ -z "$base" ] && [ "$current" != "(detached HEAD)" ]; then base="$current"; fi
dirty="clean"
if [ -n "$(git status --porcelain)" ]; then dirty="dirty"; fi
printf 'meta\\t%s\\t%s\\t%s\\n' "$current" "$base" "$dirty"
git for-each-ref --sort=-committerdate --format='%(refname:short)\t%(objectname:short)\t%(committerdate:relative)\t%(upstream:short)' refs/heads | while IFS="$(printf '\\t')" read -r name commit age upstream; do
  work=""
  if [ -n "$base" ]; then work=$(git rev-list --count "$name" --not "$base" 2>/dev/null || true); fi
  ahead=""
  behind=""
  if [ -n "$upstream" ]; then
    counts=$(git rev-list --left-right --count "$name...$upstream" 2>/dev/null || true)
    set -- $counts
    ahead="\${1:-}"
    behind="\${2:-}"
  fi
  printf 'branch\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$upstream" "$commit" "$age" "$work" "$ahead" "$behind"
done
`.trim();
}
