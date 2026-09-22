import { describe, expect, test } from "bun:test";
import { branchListItems, gitBranchesListJson } from "../../.dash-bored/scripts/git-branches";
import { packageScriptListItems, packageScriptsListJson } from "../../.dash-bored/scripts/package-scripts";
import { projectPulseChart, projectPulseStatus } from "../../.dash-bored/scripts/project-pulse";

describe("dogfood atom source scripts", () => {
  test("emits stable branch IDs and retains workload details", () => {
    const snapshot = {
      current: "main",
      base: "main",
      dirty: true,
      branches: [
        { name: "main", upstream: null, commit: "abc123", age: "2 hours ago", work: 0, ahead: null, behind: null },
        { name: "feature/work", upstream: "origin/feature/work", commit: "def456", age: "1 day ago", work: 3, ahead: 2, behind: 1 },
      ],
    };
    expect(branchListItems(snapshot)).toEqual([
      { id: "branch:main", title: "main", detail: "abc123 · 2 hours ago · no upstream · 0 commits on base", tags: ["branch", "current", "dirty"], state: "warning", name: "main" },
      { id: "branch:feature/work", title: "feature/work", detail: "def456 · 1 day ago · tracks origin/feature/work · 3 commits on base · 2 ahead · 1 behind", tags: ["branch"], state: "branch", name: "feature/work" },
    ]);
    expect(gitBranchesListJson(snapshot)).toBe(gitBranchesListJson(snapshot));
  });

  test("emits sorted package script rows with names usable by item actions", () => {
    const manifest = JSON.stringify({
      name: "demo",
      packageManager: "bun@1.3.14",
      scripts: { test: "bun test", build: "vite build" },
    });
    expect(packageScriptListItems(manifest)).toEqual([
      { id: "script:build", title: "build", detail: "vite build", tags: ["script", "bun"], name: "build", runner: "bun" },
      { id: "script:test", title: "test", detail: "bun test", tags: ["script", "bun"], name: "test", runner: "bun" },
    ]);
    expect(packageScriptsListJson(manifest)).toBe(packageScriptsListJson(manifest));
  });

  test("summarizes project status and charts package script categories", () => {
    const manifest = JSON.stringify({
      name: "demo",
      version: "2.1.0",
      scripts: { test: "bun test", "test:unit": "bun test", build: "vite build", dev: "vite", custom: "echo ok" },
    });
    expect(projectPulseStatus(manifest)).toEqual({ state: "healthy", detail: "demo v2.1.0 · 5 package scripts" });
    expect(projectPulseChart(manifest)).toEqual({
      labels: ["build", "development", "other", "test"],
      series: [{ label: "Package scripts", values: [1, 1, 1, 2] }],
    });
  });
});
