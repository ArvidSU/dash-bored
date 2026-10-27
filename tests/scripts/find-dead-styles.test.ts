import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeStyles, collectRuntimeSourceFiles } from "../../scripts/find-dead-styles";

describe("dead style analyzer", () => {
  test("separates used, dynamic, and definitely dead class hooks", () => {
    const css = `
:root { color: white; }
.used, .used:hover { color: red; }
.phase--running { color: green; }
.never-used .also-never-used { color: blue; }
@keyframes spin { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 600px) { .responsive-never-used { display: none; } }
`;
    const source = String.raw`
      <div className="used"></div>
      <span className={"phase--" + phase}></span>
    `;

    const analysis = analyzeStyles(css, [{ content: source }]);

    expect(analysis.used.map((hook) => hook.name)).toEqual(["used"]);
    expect(analysis.dynamic.map((hook) => hook.name)).toEqual(["phase--running"]);
    expect(analysis.dead.map((hook) => hook.name)).toEqual([
      "also-never-used",
      "never-used",
      "responsive-never-used",
    ]);
    expect(analysis.dead.find((hook) => hook.name === "responsive-never-used")?.lines).toEqual([7]);
  });

  test("tracks IDs and ignores class-like text inside attribute selectors", () => {
    const analysis = analyzeStyles(
      `[data-name=".not-a-class"] #app { color: white; }\n.real-class { color: black; }`,
      [{ content: `<main id="app" className="real-class" />` }],
    );

    expect(analysis.used.map((hook) => `${hook.kind}:${hook.name}`)).toEqual([
      "id:app",
      "class:real-class",
    ]);
    expect(analysis.dead).toEqual([]);
  });

  test("handles nested selectors, quoted commas, escapes, and keyframes", () => {
    const analysis = analyzeStyles(`
@media (min-width: 1px) {
  .first,
  :is(.second, [data-value="a,b"]) .escaped\\.name { color: red; }
}
@keyframes move { from { opacity: 0; } to { opacity: 1; } }
`, [{ content: '<div class="first second escaped.name" />' }]);
    expect(analysis.dead).toEqual([]);
    expect(analysis.used.map(({ name, lines }) => [name, lines])).toEqual([
      ["first", [3]], ["escaped.name", [4]], ["second", [4]],
    ]);
  });

  test("collects runtime sources recursively, including built-ins", async () => {
    const files = await collectRuntimeSourceFiles(resolve(import.meta.dirname, "../../src/renderer"));

    expect(files.some((file) => file.path.endsWith("src/renderer/render/ComponentWebviewSurface.tsx"))).toBe(true);
  });

  test("skips hidden directories and symlinks while retaining hidden source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "style-sources-"));
    try {
      await mkdir(join(root, ".private"));
      await writeFile(join(root, ".private", "ignored.ts"), "");
      await writeFile(join(root, ".visible.ts"), "");
      await symlink(join(root, ".visible.ts"), join(root, "link.ts"));
      expect((await collectRuntimeSourceFiles(root)).map(({ path }) => path)).toEqual([join(root, ".visible.ts")]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("CLI reports dead hooks in JSON and exits nonzero with --check", async () => {
    const root = await mkdtemp(join(tmpdir(), "style-cli-"));
    try {
      const css = join(root, "test.css");
      await writeFile(css, ".unique-unused-test-hook { color: red; }");
      const result = Bun.spawnSync([process.execPath, resolve(import.meta.dirname, "../../scripts/find-dead-styles.ts"), "--check", "--json", css]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout.toString()).dead[0].name).toBe("unique-unused-test-hook");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
