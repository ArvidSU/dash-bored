import { describe, expect, test } from "bun:test";
import {
  packageRunner,
  packageScriptActionId,
  packageScriptCommand,
  packageScriptOutput,
  packageWorkingDirectory,
  parsePackageScripts,
  stripAnsi,
} from "../../dash-bored/components/package-scripts/package-scripts";

describe("package scripts component", () => {
  test("parses and sorts string-valued package scripts", () => {
    expect(parsePackageScripts(JSON.stringify({
      name: "example",
      version: "1.2.3",
      packageManager: "bun@1.3.14",
      scripts: {
        test: "bun test",
        build: "vite build",
        invalid: { command: "ignored" },
      },
    }))).toEqual({
      name: "example",
      version: "1.2.3",
      packageManager: "bun@1.3.14",
      scripts: [
        { name: "build", command: "vite build" },
        { name: "test", command: "bun test" },
      ],
    });
  });

  test("selects the configured or manifest package runner", () => {
    expect(packageRunner("bun@1.3.14")).toBe("bun");
    expect(packageRunner("pnpm@9", "npm")).toBe("npm");
    expect(packageRunner("unknown@1")).toBe("npm");
  });

  test("quotes script names and runs them from the package directory", () => {
    expect(packageScriptCommand("bun", "build:prod")).toBe("bun run 'build:prod'");
    expect(packageScriptCommand("npm", "say'hello")).toBe("npm run 'say'\\''hello'");
    expect(packageWorkingDirectory("packages/app/package.json")).toBe("packages/app");
    expect(packageWorkingDirectory("package.json")).toBe(".");
    expect(packageScriptActionId(0)).toBe("run-package-script-1");
  });

  test("keeps action output bounded for the component view", () => {
    const output = packageScriptOutput("\u001b[32mout\u001b[0m", "\u001b[31merr\u001b[0m");
    expect(output).toBe("out\nerr");
    expect(packageScriptOutput("x".repeat(12_001), "")).toHaveLength(12_001);
  });

  test("removes terminal formatting controls without changing visible text", () => {
    expect(stripAnsi("\u001b[0m\u001b[32m✓\u001b[0m project paths \u001b[2m>\u001b[0m\u001b[1m resolves\u001b[0m"))
      .toBe("✓ project paths > resolves");
  });
});
