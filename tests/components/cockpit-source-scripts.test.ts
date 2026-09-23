import { describe, expect, test } from "bun:test";
import { dashboardHealth } from "../../.dash-bored/scripts/dashboard-health";
import { changeListItems } from "../../.dash-bored/scripts/git-changes";
import { activityChart, commitListItems } from "../../.dash-bored/scripts/git-log";
import { releaseListItems } from "../../.dash-bored/scripts/releases";
import { roadmapListItems } from "../../.dash-bored/scripts/roadmap";
import { findTodos, todoChart, todoStatus } from "../../.dash-bored/scripts/todo-stats";
import { workspaceStatus } from "../../.dash-bored/scripts/workspace-status";

describe("project cockpit source scripts", () => {
  test("lists working-tree changes with stable path IDs, skipping rename sources", () => {
    const porcelain = ["M  src/a.ts", " M README.md", "MM src/b.ts", "?? notes/new.md", "R  src/new-name.ts", "src/old-name.ts", "UU src/conflict.ts", ""].join("\0");
    const items = changeListItems(porcelain);
    expect(items.map((item) => [item.id, item.state, item.tags])).toEqual([
      ["change:notes/new.md", "untracked", ["untracked", "notes"]],
      ["change:README.md", "modified", ["unstaged", "(root)"]],
      ["change:src/a.ts", "modified", ["staged", "src"]],
      ["change:src/b.ts", "modified", ["staged", "unstaged", "src"]],
      ["change:src/conflict.ts", "conflict", ["conflict", "src"]],
      ["change:src/new-name.ts", "renamed", ["staged", "src"]],
    ]);
    expect(items[3]!.detail).toBe("modified · partially staged");
    expect(items[1]!.prompt).toContain("README.md");
  });

  test("parses commit records and buckets activity by local day", () => {
    const record = (subject: string) => ["f".repeat(40), "fffffff", "Ada", "2 hours ago", subject].join("\x1f");
    expect(commitListItems(`${record("feat(list): add rows")}\x1e\n${record("Plain subject")}\x1e\n`)).toEqual([
      { id: `commit:${"f".repeat(40)}`, title: "feat(list): add rows", detail: "fffffff · Ada · 2 hours ago", tags: ["feat", "list"], sha: "f".repeat(40) },
      { id: `commit:${"f".repeat(40)}`, title: "Plain subject", detail: "fffffff · Ada · 2 hours ago", tags: ["other"], sha: "f".repeat(40) },
    ]);
    expect(activityChart(["2026-09-22", "2026-09-22", "2026-09-23", "2026-01-01"], new Date(2026, 8, 23), 3)).toEqual({
      labels: ["09-21", "09-22", "09-23"],
      series: [{ label: "Commits", values: [0, 2, 1] }],
    });
  });

  test("summarizes working tree state", () => {
    expect(workspaceStatus("# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n")).toEqual({ state: "healthy", detail: "main · clean · in sync" });
    expect(workspaceStatus("# branch.head topic\n1 .M N... a\n? b\n")).toEqual({ state: "warning", detail: "topic · 1 changed, 1 untracked · no upstream" });
    expect(workspaceStatus("# branch.head topic\nu UU N... a\n").state).toBe("error");
  });

  test("maps validation output to a status", () => {
    expect(dashboardHealth(JSON.stringify({ ok: true, diagnostics: [] })).state).toBe("healthy");
    expect(dashboardHealth(JSON.stringify({ ok: true, diagnostics: [{ severity: "warning", code: "x", message: "Legacy reference" }] }))).toEqual({ state: "warning", detail: "1 warning · Legacy reference" });
    expect(dashboardHealth(JSON.stringify({ ok: false, diagnostics: [{ severity: "error", code: "x", message: "Bad" }] }))).toEqual({ state: "error", detail: "1 error · Bad" });
  });

  test("counts todos of a node found by ID", () => {
    const todos = [
      { id: "a", description: "A", done: false, tags: ["bug"] },
      { id: "b", description: "B", done: true, tags: ["feature"] },
      { id: "c", description: "C", done: false, tags: ["Feature"] },
    ];
    const dashboard = { root: { id: "root", children: { first: { node: { id: "yaml-todo", props: { todos } } } } } };
    expect(findTodos(dashboard, "yaml-todo")).toBe(todos);
    expect(findTodos(dashboard, "missing")).toBeUndefined();
    expect(todoStatus(todos)).toEqual({ state: "warning", detail: "2 open · 1 done · 1 open bug" });
    expect(todoChart(todos)).toEqual({
      labels: ["bug", "feature"],
      series: [{ label: "Open", values: [1, 1] }, { label: "Done", values: [0, 1] }],
    });
  });

  test("reads the roadmap implementation-status table", () => {
    const markdown = "# Roadmap\n\n## Implementation status\n\n| Package | Status | Evidence |\n|---|---|---|\n| WP1 | Implemented | Done. |\n| WP9 | In progress | Migration remains. |\n\n## Next\n";
    expect(roadmapListItems(markdown, "docs/roadmap.md").map((item) => [item.id, item.state, item.detail])).toEqual([
      ["work-package:WP1", "done", "Done."],
      ["work-package:WP9", "in progress", "Migration remains."],
    ]);
  });

  test("labels releases by channel", () => {
    expect(releaseListItems([
      { tag_name: "v1.0.0", name: "One", draft: false, prerelease: true, published_at: "2026-08-24T10:00:00Z", assets: [{ name: "a", download_count: 3 }] },
    ])).toEqual([
      { id: "release:v1.0.0", title: "One", detail: "v1.0.0 · 2026-08-24 · 1 assets · 3 downloads", tags: ["prerelease"], state: "prerelease", tag: "v1.0.0" },
    ]);
  });
});
