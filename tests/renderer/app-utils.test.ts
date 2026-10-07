import { describe, expect, test } from "bun:test";
import {
  createDashboardEditSession,
  isCompositionSourceCurrent,
  mergeThemeCatalog,
  patchDashboardAppearance,
  sameDashboardConfig,
} from "../../src/renderer/app/app-utils";
import type {
  DashboardCompositionSource,
} from "../../src/renderer/composition/composition-interaction-controller";
import type {
  DashboardConfig,
  DashboardConfigSource,
  DashboardDraftValidation,
  ProjectSnapshot,
} from "../../src/shared/contracts";

function dashboard(): DashboardConfig {
  return {
    schemaVersion: 4,
    name: "Example",
    root: {
      id: "root",
      component: "./components/external/core/group",
      props: { nested: { value: 1 } },
    },
  };
}

describe("renderer app helpers", () => {
  test("draft changes ignore mapping order but retain values and child order", () => {
    const original = dashboard();
    original.root.props = { title: "Example", nested: { a: 1, b: 2 } };
    const reordered = structuredClone(original);
    reordered.root.props = { nested: { b: 2, a: 1 }, title: "Example" };
    expect(sameDashboardConfig(original, reordered)).toBe(true);
    reordered.root.props.nested = { b: 2, a: 3 };
    expect(sameDashboardConfig(original, reordered)).toBe(false);
    original.root.children = [{ node: { id: "a", component: "a" } }, { node: { id: "b", component: "b" } }];
    const moved = structuredClone(original);
    (moved.root.children as typeof original.root.children).reverse();
    expect(sameDashboardConfig(original, moved)).toBe(false);
  });

  test("creates independent original and draft dashboard copies", () => {
    const config = dashboard();
    const catalog: DashboardConfigSource["componentCatalog"] = [];
    const source: DashboardConfigSource = {
      configPath: "/project/.dash-bored/dash-bored.yaml",
      config,
      configRevision: "revision-1",
      componentCatalog: catalog,
    };
    const validation: DashboardDraftValidation = {
      ok: true,
      diagnostics: [],
      requestedPermissions: [],
      tree: null,
      components: [],
      trusted: false,
    };

    const session = createDashboardEditSession("/project", source, validation);

    expect(session).toMatchObject({
      projectRoot: "/project",
      configPath: source.configPath,
      expectedConfigRevision: source.configRevision,
      validation,
    });
    expect(session.componentCatalog).toBe(catalog);
    expect(session.original).toEqual(config);
    expect(session.draft).toEqual(config);
    expect(session.original).not.toBe(session.draft);
    expect(session.original.root).not.toBe(session.draft.root);
    expect(session.original.root.props).not.toBe(session.draft.root.props);
    expect(session.original.root.props?.nested).not.toBe(session.draft.root.props?.nested);
  });

  test("patches only present appearance fields and removes inherited values", () => {
    const config = { ...dashboard(), theme: "global:midnight", themeMode: "light" as const };

    const changed = patchDashboardAppearance(config, {
      theme: "global:paper",
      themeMode: undefined,
    });
    expect(changed).toMatchObject({ theme: "global:paper" });
    expect(Object.hasOwn(changed, "themeMode")).toBeFalse();
    expect(config).toMatchObject({ theme: "global:midnight", themeMode: "light" });

    const inherited = patchDashboardAppearance(changed, { theme: undefined });
    expect(Object.hasOwn(inherited, "theme")).toBeFalse();
    expect(inherited).toMatchObject({ schemaVersion: 4, name: "Example" });
  });

  test("merges application themes before project-local themes and preserves duplicates", () => {
    const application = [
      { reference: "builtin:default", name: "Default" },
      { reference: "global:midnight", name: "Midnight" },
    ];
    const project = [
      { reference: "project:/path:./themes/local", name: "Qualified local" },
      { reference: "./themes/local", name: "Legacy local" },
      { reference: "./themes/local", name: "Repeated local" },
      { reference: "global:ignored", name: "Not project-local" },
    ];

    expect(mergeThemeCatalog(application, project).map(({ reference }) => reference)).toEqual([
      "builtin:default",
      "global:midnight",
      "./themes/local",
      "./themes/local",
    ]);
  });

  test("checks composition source identity against the current dashboard snapshot", () => {
    const source: DashboardCompositionSource = {
      projectRoot: "/project",
      activeDashboardPath: "/project/.dash-bored/dash-bored.yaml",
      focusedSourcePath: "/project/linked/.dash-bored/dash-bored.yaml",
      snapshotRevision: 7,
      configPath: "/project/linked/.dash-bored/dash-bored.yaml",
      componentCatalog: [],
      config: dashboard(),
      validation: {
        ok: true,
        diagnostics: [],
        requestedPermissions: [],
        tree: null,
        components: [],
        trusted: false,
      },
    };
    const snapshot = {
      projectRoot: source.projectRoot,
      configPath: source.activeDashboardPath,
      revision: source.snapshotRevision,
    } as ProjectSnapshot;

    expect(isCompositionSourceCurrent(source, snapshot, source.focusedSourcePath)).toBeTrue();
    expect(isCompositionSourceCurrent(source, { ...snapshot, revision: 8 }, source.focusedSourcePath)).toBeFalse();
    expect(isCompositionSourceCurrent(source, snapshot, "/other/config.yaml")).toBeFalse();
  });
});
