import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

const fixtures = process.env.DASH_BORED_FIXTURE === "1";
if (fixtures) execFileSync("bun", ["scripts/build-core-fixture.ts"], { cwd: import.meta.dirname });

export default defineConfig({
  plugins: [react(), {
    name: "isolated-test-fixture",
    resolveId(id) {
      if (id === "virtual:dash-bored-fixture-host") return fixtures
        ? resolve(import.meta.dirname, "tests/helpers/ui-harness-host.ts")
        : "\0empty-fixture-host";
    },
    load(id) {
      if (id === "\0empty-fixture-host") return 'export function createUiHarnessHost() { throw new Error("Test fixtures are disabled"); }';
    },
  }],
  resolve: {
    alias: electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")),
  },
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DASH_BORED_VITE_PORT ?? 5173),
    strictPort: true,
    // The privileged dev renderer must never be framed, including through a
    // redirect from a preview. Fixture servers carry no real host bridge.
    headers: fixtures ? {} : { "Content-Security-Policy": "frame-ancestors 'none'" },
  },
});
