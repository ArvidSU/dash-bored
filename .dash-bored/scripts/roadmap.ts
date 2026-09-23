import { emit } from "./lib/run";

export interface RoadmapListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  state: string;
  prompt: string;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** Read the "Implementation status" table of a roadmap Markdown file. */
export function roadmapListItems(markdown: string, roadmapPath: string): RoadmapListItem[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith("Implementation status"));
  if (!section) return [];
  const rows = section.split("\n").filter((line) => line.trim().startsWith("|"));
  return rows.slice(2).map((row) => {
    const [work = "", status = "", evidence = ""] = cells(row);
    const normalized = status.toLowerCase();
    const state = normalized.startsWith("in progress") ? "in progress" : normalized.startsWith("implemented") ? (normalized.includes("additively") ? "additive" : "done") : normalized || "planned";
    return {
      id: `work-package:${work}`,
      title: work,
      detail: evidence,
      tags: ["roadmap", state],
      state: state === "done" ? "done" : state,
      prompt: `Continue atoms roadmap ${work} (${status}) described in ${roadmapPath}. Read docs/IDEA.md and the roadmap first, propose the next scoped step, and wait for confirmation before editing.`,
    };
  });
}

if (import.meta.main) {
  const path = process.env.DASH_BORED_ROADMAP || "docs/roadmap/atoms.md";
  try {
    emit(roadmapListItems(await Bun.file(path).text(), path));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
}
