import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { inspectProjectDeletion } from "../../src/core";
import type {
  ComponentChildLayout,
  ComponentNode,
  DashboardConfig,
  ProjectListItem,
} from "../../src/shared/contracts";
import {
  createProject,
  removeTemporaryDirectory,
  temporaryDirectory,
  writeLocalComponent,
} from "./helpers";

const cleanup: string[] = [];

function child(node: ComponentNode): ComponentChildLayout {
  return { type: "child", child: { node } };
}

function vertical(nodes: readonly ComponentNode[]): ComponentChildLayout {
  if (nodes.length === 1) return child(nodes[0]!);
  const middle = Math.ceil(nodes.length / 2);
  return {
    type: "split",
    axis: "vertical",
    ratio: 0.5,
    first: vertical(nodes.slice(0, middle)),
    second: vertical(nodes.slice(middle)),
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

function linkConfig(name: string, references: readonly string[]): DashboardConfig {
  const nodes = references.map((component, index) => ({
    id: `link-${index}`,
    component,
  }));
  return {
    schemaVersion: 2,
    name,
    root: {
      component: "@dash-bored/group",
      ...(nodes.length === 0
        ? {}
        : { children: { type: "tiled", layout: vertical(nodes) } }),
    },
  };
}

function project(root: string, dashboardName: string): ProjectListItem {
  return {
    projectRoot: root,
    configPath: join(root, "dash-bored", "dash-bored.yaml"),
    dashboardName,
  };
}

describe("project deletion dependency analysis", () => {
  test("finds direct relative, absolute, and transitive links into the target files", async () => {
    const target = await temporaryDirectory();
    const relativeSource = await temporaryDirectory();
    const absoluteSource = await temporaryDirectory();
    const transitiveSource = await temporaryDirectory();
    cleanup.push(target, relativeSource, absoluteSource, transitiveSource);
    await Promise.all([createProject(target), createProject(relativeSource), createProject(absoluteSource), createProject(transitiveSource)]);

    const [targetRoot, relativeSourceRoot, absoluteSourceRoot, transitiveSourceRoot] = await Promise.all([
      realpath(target),
      realpath(relativeSource),
      realpath(absoluteSource),
      realpath(transitiveSource),
    ]);
    const targetFiles = join(targetRoot, "dash-bored");
    await writeFile(
      join(relativeSource, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("Relative source", [relative(join(relativeSourceRoot, "dash-bored"), targetFiles)])),
    );
    await writeFile(
      join(absoluteSource, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("Absolute source", [targetFiles])),
    );

    const nested = join(transitiveSource, "dash-bored", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "dash-bored.yaml"),
      stringify(linkConfig("Nested link", [targetFiles])),
    );
    await writeFile(
      join(transitiveSource, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("Transitive source", ["./nested"])),
    );

    const preview = await inspectProjectDeletion(
      project(targetRoot, "Target"),
      [
        project(targetRoot, "Target"),
        project(relativeSourceRoot, "Relative source"),
        project(absoluteSourceRoot, "Absolute source"),
        project(transitiveSourceRoot, "Transitive source"),
      ],
    );

    expect(preview.filesExist).toBeTrue();
    expect(preview.analysisComplete).toBeTrue();
    expect(preview.dependencies.map((item) => item.dashboardName)).toEqual([
      "Absolute source",
      "Relative source",
      "Transitive source",
    ]);
    expect(preview.dependencies.every((item) => item.configPaths.length > 0)).toBeTrue();
    expect(preview.dependencies.every((item) => item.configPaths.some((path) => path.endsWith("dash-bored.yaml")))).toBeTrue();
  });

  test("fails closed for broken and unreadable links while retaining affected paths", async () => {
    const target = await temporaryDirectory();
    const source = await temporaryDirectory();
    cleanup.push(target, source);
    await Promise.all([createProject(target), createProject(source)]);

    const [targetRoot, sourceRoot] = await Promise.all([realpath(target), realpath(source)]);
    const unreadable = join(targetRoot, "dash-bored", "private");
    await mkdir(unreadable, { recursive: true });
    const unreadableConfig = join(unreadable, "dash-bored.yaml");
    await writeFile(unreadableConfig, stringify(linkConfig("Private", [])));
    await writeFile(join(unreadable, "dash-bored-lock.yaml"), "lockfileVersion: 1\ncomponents: {}\n");
    await writeFile(
      join(source, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("Broken links", [
        join(targetRoot, "dash-bored", "missing"),
        unreadable,
      ])),
    );
    await chmod(unreadableConfig, 0);

    try {
      const preview = await inspectProjectDeletion(
        project(targetRoot, "Target"),
        [project(targetRoot, "Target"), project(sourceRoot, "Broken links")],
      );

      expect(preview.analysisComplete).toBeFalse();
      expect(preview.analysisIssues.length).toBeGreaterThanOrEqual(2);
      expect(preview.dependencies).toEqual([
        {
          projectRoot: sourceRoot,
          dashboardName: "Broken links",
          configPaths: [
            join(targetRoot, "dash-bored", "missing"),
            unreadable,
          ].sort(),
        },
      ]);
    } finally {
      await chmod(unreadableConfig, 0o644);
    }
  });

  test("ignores valid links outside the target and rejects a symlinked target directory", async () => {
    const target = await temporaryDirectory();
    const source = await temporaryDirectory();
    const outside = await temporaryDirectory();
    cleanup.push(target, source, outside);
    await Promise.all([createProject(target), createProject(source), createProject(outside)]);

    const [targetRoot, sourceRoot, outsideRoot] = await Promise.all([
      realpath(target),
      realpath(source),
      realpath(outside),
    ]);

    await writeFile(
      join(source, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("External source", [join(outsideRoot, "dash-bored")])),
    );
    const safePreview = await inspectProjectDeletion(
      project(targetRoot, "Target"),
      [project(targetRoot, "Target"), project(sourceRoot, "External source")],
    );
    expect(safePreview.analysisComplete).toBeTrue();
    expect(safePreview.dependencies).toEqual([]);

    await rm(join(target, "dash-bored"), { recursive: true });
    await symlink(join(outside, "dash-bored"), join(target, "dash-bored"));
    const unsafePreview = await inspectProjectDeletion(project(targetRoot, "Target"), [project(targetRoot, "Target")]);
    expect(unsafePreview.filesExist).toBeFalse();
    expect(unsafePreview.analysisComplete).toBeFalse();
    expect(unsafePreview.analysisIssues.join(" ")).toContain("outside the allowed directory");
  });

  test("ignores unrelated local component code outside the target files", async () => {
    const source = await temporaryDirectory();
    const target = join(source, "new-dashboard");
    cleanup.push(source);
    await createProject(source, {
      schemaVersion: 2,
      name: "Local source",
      root: { component: "./components/reader" },
    });
    await mkdir(target, { recursive: true });
    await createProject(target);
    await writeLocalComponent(source, "reader", "export default () => null;");
    const [targetRoot, sourceRoot] = await Promise.all([realpath(target), realpath(source)]);

    const preview = await inspectProjectDeletion(
      project(targetRoot, "Target"),
      [project(targetRoot, "Target"), project(sourceRoot, "Local source")],
    );

    expect(preview.analysisComplete).toBeTrue();
    expect(preview.analysisIssues).toEqual([]);
    expect(preview.dependencies).toEqual([]);
  });

  test("fails closed when a registered local component is inside the target files", async () => {
    const target = await temporaryDirectory();
    const source = join(target, "dash-bored", "nested-dashboard");
    cleanup.push(target);
    await createProject(target);
    await mkdir(source, { recursive: true });
    await createProject(source, {
      schemaVersion: 2,
      name: "Local source",
      root: { component: "./components/reader" },
    });
    await writeLocalComponent(source, "reader", "export default () => null;");
    const [targetRoot, sourceRoot] = await Promise.all([realpath(target), realpath(source)]);

    const preview = await inspectProjectDeletion(
      project(targetRoot, "Target"),
      [project(targetRoot, "Target"), project(sourceRoot, "Local source")],
    );

    expect(preview.analysisComplete).toBeFalse();
    expect(preview.analysisIssues.join(" ")).toContain("statically determine file access");
  });

  test("reports a target-local symlink link even when its resolved config is external", async () => {
    const target = await temporaryDirectory();
    const source = await temporaryDirectory();
    const outside = await temporaryDirectory();
    cleanup.push(target, source, outside);
    await Promise.all([createProject(target), createProject(source), createProject(outside)]);
    const [targetRoot, sourceRoot, outsideRoot] = await Promise.all([
      realpath(target),
      realpath(source),
      realpath(outside),
    ]);
    const linkedPath = join(targetRoot, "dash-bored", "external-link");
    await symlink(join(outsideRoot, "dash-bored"), linkedPath);
    await writeFile(
      join(source, "dash-bored", "dash-bored.yaml"),
      stringify(linkConfig("Symlink source", [linkedPath])),
    );

    const preview = await inspectProjectDeletion(
      project(targetRoot, "Target"),
      [project(targetRoot, "Target"), project(sourceRoot, "Symlink source")],
    );

    expect(preview.analysisComplete).toBeTrue();
    expect(preview.dependencies[0]?.configPaths).toContain(linkedPath);
  });
});
