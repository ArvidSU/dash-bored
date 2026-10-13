import { describe, expect, test } from "bun:test";
import { latestReleaseTag, parseGitStatus, readinessStatus, releaseBlockers, setPackageVersion, versionCandidates, type ReleaseState } from "../../.dash-bored/scripts/release";

const clean = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n";
const bumped = `${clean}1 .M N... 100644 100644 100644 aaa bbb package.json\n`;

function state(porcelain: string, overrides: Partial<ReleaseState> = {}): ReleaseState {
  return { git: parseGitStatus(porcelain), version: "0.5.2", latestTag: "v0.5.1", tagExists: false, versionOnlyBump: true, ...overrides };
}

describe("release script", () => {
  test("parses branch sync and every kind of change", () => {
    const git = parseGitStatus([
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb src/a file.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
      "? notes.md",
    ].join("\n"));
    expect(git).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      changes: [
        { path: "src/a file.ts", conflict: false },
        { path: "src/new.ts", conflict: false },
        { path: "src/conflict.ts", conflict: true },
        { path: "notes.md", conflict: false },
      ],
    });
  });

  test("is ready with only a version bump on a main that matches origin", () => {
    expect(releaseBlockers(state(bumped))).toEqual([]);
    expect(readinessStatus(state(bumped))).toEqual({ state: "healthy", detail: "Ready to cut v0.5.2 · commits the version bump" });
    expect(readinessStatus(state(clean))).toEqual({ state: "healthy", detail: "Ready to cut v0.5.2 · version committed" });
  });

  test("blocks uncommitted and unpushed work", () => {
    const dirty = `${clean.replace("+0 -0", "+2 -0")}1 .M N... 100644 100644 100644 aaa bbb src/a.ts\n? b.md\n? c.md\n? d.md\n`;
    expect(releaseBlockers(state(dirty))).toEqual(["2 unpushed commits", "uncommitted: src/a.ts, b.md, c.md +1 more"]);
    expect(releaseBlockers(state(clean.replace("+0 -0", "+0 -3")))).toEqual(["3 commits behind origin/main"]);
    expect(releaseBlockers(state(bumped, { versionOnlyBump: false }))).toEqual(["package.json has uncommitted changes besides its version"]);
    expect(readinessStatus(state(dirty)).state).toBe("warning");
    expect(readinessStatus(state(`${clean}u UU N... 100644 100644 100644 100644 aaa bbb ccc x.ts\n`)).state).toBe("error");
  });

  test("blocks other branches, missing upstreams, and versions that are not new", () => {
    expect(releaseBlockers(state("# branch.head topic\n"))).toEqual(["on topic, not main"]);
    expect(releaseBlockers(state("# branch.head main\n"))).toEqual(["main does not track origin/main"]);
    expect(releaseBlockers(state(clean, { version: "0.5.0" }))).toEqual(["0.5.0 is not newer than v0.5.1"]);
    expect(releaseBlockers(state(clean, { version: "next" }))).toEqual(['package.json version "next" is not MAJOR.MINOR.PATCH']);
    const released = state(clean, { version: "0.5.1", tagExists: true });
    expect(releaseBlockers(released)).toEqual(["v0.5.1 is already tagged"]);
    expect(readinessStatus(released)).toEqual({ state: "unknown", detail: "v0.5.1 is released · choose the next version" });
  });

  test("offers the next versions after the latest release tag", () => {
    expect(latestReleaseTag(["v0.4.2", "v0.10.0", "v0.9.1", "nightly", "v0.10.0-rc.1"])).toBe("v0.10.0");
    expect(latestReleaseTag([])).toBeNull();
    expect(versionCandidates("v0.5.1", "0.5.1").map((item) => [item.title, item.detail, item.state])).toEqual([
      ["v0.5.2", "After v0.5.1", undefined],
      ["v0.6.0", "After v0.5.1", undefined],
      ["v1.0.0", "After v0.5.1", undefined],
    ]);
    expect(versionCandidates("v0.5.1", "0.6.0")[1]).toMatchObject({ id: "version:0.6.0", detail: "After v0.5.1 · set in package.json", tags: ["minor"], state: "healthy", version: "0.6.0" });
    expect(versionCandidates("v0.5.1", "0.6.0-beta.1")[0]).toMatchObject({ title: "v0.6.0-beta.1", tags: ["custom"], state: "healthy" });
    expect(versionCandidates("v0.6.0-rc.1", "0.6.0-rc.1")[0]!.version).toBe("0.6.0");
    expect(versionCandidates(null, "0.0.0")[0]).toMatchObject({ version: "0.0.1", detail: "First release" });
  });

  test("rewrites only package.json's top-level version", () => {
    const text = '{\n  "name": "x",\n  "version": "0.5.1",\n  "dependencies": { "y": { "version": "1.0.0" } }\n}\n';
    expect(setPackageVersion(text, "0.6.0")).toBe(text.replace('"version": "0.5.1"', '"version": "0.6.0"'));
    expect(() => setPackageVersion('{ "name": "x" }', "1.0.0")).toThrow("no version field");
  });
});
