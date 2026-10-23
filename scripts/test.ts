import { resolve } from "node:path";
import { DEFAULT_COMPONENT_PACKAGE } from "../src/shared/default-component-package";
// Tests restore the actual pinned package from a local checkout, never GitHub.
const core = resolve(import.meta.dirname, "../.dash-bored/components/external/core");
const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
// Hosted macOS runners have limited process capacity; keep browser and Git
// fixture suites from exhausting it while preserving parallel local runs.
// Local runs share one process, so isolate each file: a browser suite's
// teardown otherwise cuts the next suite's Chrome DevTools pipe, and Playwright
// then waits forever instead of reporting the closed browser.
const parallelArgs = process.env.CI ? ["--parallel=1"] : ["--isolate"];
await import("./build-core-fixture");
const child = Bun.spawn(["bun", "test", "./tests", ...parallelArgs, ...process.argv.slice(2).filter((arg) => arg !== "--")], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: `url.file://${core}.insteadOf`, [`GIT_CONFIG_VALUE_${count}`]: DEFAULT_COMPONENT_PACKAGE.url },
});
process.exit(await child.exited);
