import { emit, runOrExit } from "./lib/run";

export interface CommitListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  sha: string;
}

export interface ActivityChart {
  labels: string[];
  series: Array<{ label: string; values: number[] }>;
}

const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = `%H${FIELD}%h${FIELD}%an${FIELD}%ar${FIELD}%s${RECORD}`;

function commitType(subject: string): string {
  const match = /^([a-z]+)(\([^)]*\))?!?:/i.exec(subject);
  return match ? match[1]!.toLowerCase() : "other";
}

/** Parse `git log` records using the LOG_FORMAT separators into list items. */
export function commitListItems(output: string): CommitListItem[] {
  return output.split(RECORD).map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha = "", short = "", author = "", age = "", subject = ""] = record.split(FIELD);
    const scope = /^[a-z]+\(([^)]*)\)/i.exec(subject)?.[1];
    return {
      id: `commit:${sha}`,
      title: subject,
      detail: `${short} · ${author} · ${age}`,
      tags: scope ? [commitType(subject), scope] : [commitType(subject)],
      sha,
    };
  });
}

/** Count commits per local calendar day over the trailing `days` window ending on `today`. */
export function activityChart(dates: string[], today: Date, days = 14): ActivityChart {
  const labels: string[] = [];
  const counts = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    labels.push(key);
    counts.set(key, 0);
  }
  for (const date of dates) {
    const key = date.trim().slice(0, 10);
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return {
    labels: labels.map((label) => label.slice(5)),
    series: [{ label: "Commits", values: labels.map((label) => counts.get(label) ?? 0) }],
  };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "list";
  if (mode === "list") {
    const limit = Number(process.env.DASH_BORED_LOG_LIMIT || "25");
    emit(commitListItems(runOrExit(["git", "log", `-${limit}`, `--format=${LOG_FORMAT}`])));
  } else if (mode === "activity") {
    const dates = runOrExit(["git", "log", "--all", "--since=15 days ago", "--date=format-local:%Y-%m-%d", "--format=%ad"]);
    emit(activityChart(dates.split("\n"), new Date()));
  } else {
    process.stderr.write("Usage: bun run .dash-bored/scripts/git-log.ts <list|activity>\n");
    process.exit(2);
  }
}
