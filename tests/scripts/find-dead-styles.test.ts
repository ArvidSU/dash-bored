import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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

  test("collects runtime sources recursively, including built-ins", async () => {
    const files = await collectRuntimeSourceFiles(resolve(import.meta.dirname, "../../src/renderer"));

    expect(files.some((file) => file.path.endsWith("src/renderer/builtins/text/index.tsx"))).toBe(true);
  });
});
