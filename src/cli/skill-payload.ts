import { createHash } from "node:crypto";
import { APP_VERSION } from "../shared/app-metadata";
import skillMarkdown from "../../skills/dash-bored/SKILL.md" with { type: "text" };
import openAiMetadata from "../../skills/dash-bored/agents/openai.yaml" with { type: "text" };
import componentReference from "../../skills/dash-bored/references/components.md" with { type: "text" };
import appRuntimeReference from "../../skills/dash-bored/references/app-runtime.md" with { type: "text" };
import builtinsReference from "../../skills/dash-bored/references/builtins.md" with { type: "text" };

/** Files embedded into the standalone CLI at build time. */
const SKILL_CONTENTS = {
  "SKILL.md": skillMarkdown,
  "agents/openai.yaml": openAiMetadata,
  "references/components.md": componentReference,
  "references/builtins.md": builtinsReference,
  "references/app-runtime.md": appRuntimeReference,
} as const;

export function skillContentHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Receipt of the exact shipped files; version alone cannot prove ownership. */
export const SKILL_VERSION_MANIFEST = `${JSON.stringify({
  skillVersion: APP_VERSION,
  files: Object.fromEntries(Object.entries(SKILL_CONTENTS).map(([path, contents]) => [path, skillContentHash(contents)])),
}, null, 2)}\n`;

export const DASH_BORED_SKILL_FILES = {
  ...SKILL_CONTENTS,
  "skill-version.json": SKILL_VERSION_MANIFEST,
} as const;
