import { resolve } from "node:path";
import { CORE_PACKAGE } from "../src/shared/core-package";
// Tests restore the actual pinned package from a local checkout, never GitHub.
const core = resolve(import.meta.dirname, "../.dash-bored/components/external/core");
const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
// Hosted macOS runners have limited process capacity; keep browser and Git
// fixture suites from exhausting it while preserving parallel local runs.
const parallelArgs = process.env.CI ? ["--parallel=1"] : [];
await import("./build-core-fixture");
const child = Bun.spawn(["bun", "test", "./tests", ...parallelArgs, ...process.argv.slice(2).filter((arg) => arg !== "--")], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: `url.file://${core}.insteadOf`, [`GIT_CONFIG_VALUE_${count}`]: CORE_PACKAGE.url },
});
process.exit(await child.exited);
