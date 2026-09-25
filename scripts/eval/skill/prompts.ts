// Writes <run>.prompt.txt for every run directory, using the app's own prompt
// builders so each eval agent receives exactly what the desktop app would send.
// Usage: bun scripts/eval/skill/prompts.ts <eval-dir>
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { starterAgentPrompt } from "../../../src/core/project-files";
import {
  buildComponentAgentPrompt,
  buildComponentCreationAgentPrompt,
  type DashboardInsertion,
} from "../../../src/shared/component-agent";

const evalDir = resolve(process.argv[2] ?? "");
const runs = readdirSync(join(evalDir, "runs"), { withFileTypes: true }).filter((entry) => entry.isDirectory());

for (const { name } of runs) {
  const root = join(evalDir, "runs", name);
  const configPath = join(root, ".dash-bored/dash-bored.yaml");
  let prompt: string;
  if (name.startsWith("acme-api-")) {
    prompt = starterAgentPrompt("acme-api", configPath);
  } else if (name.startsWith("ledger-tools-")) {
    prompt = buildComponentAgentPrompt({
      projectRoot: root,
      configPath,
      componentPath: `${configPath}#id=service-status`,
      componentId: "service-status",
      componentReference: "@dash-bored/status",
    }, "This always says healthy, even when the API is down. Make it show whether the API on port 8000 actually responds. Also put something next to it that lists the files I've changed but not committed yet, and lets me open the diff for one of them.");
  } else if (name.startsWith("field-notes-")) {
    // Hand-built to match what resolveDashboardInsertion returns for a
    // horizontal split to the right of serve-docs; keep in sync with its type.
    const insertion: DashboardInsertion = {
      path: "root.children.second.second",
      parentPath: "root",
      parent: { id: "notes-root", component: "@dash-bored/group" },
      placement: {
        type: "split",
        edgePath: "root.children.second",
        existing: { id: "serve-docs", component: "@dash-bored/command" },
        axis: "horizontal",
        position: "second",
      },
    };
    prompt = buildComponentCreationAgentPrompt({ projectRoot: root, configPath, insertion },
      "a panel listing every TODO and FIXME left in the docs, with a way to hand one to my agent to fix");
  } else {
    continue;
  }
  writeFileSync(join(evalDir, "runs", `${name}.prompt.txt`), prompt);
}
