import skillMarkdown from "../../skills/dash-bored/SKILL.md" with { type: "text" };
import openAiMetadata from "../../skills/dash-bored/agents/openai.yaml" with { type: "text" };
import componentReference from "../../skills/dash-bored/references/components.md" with { type: "text" };

/** Files embedded into the standalone CLI at build time. */
export const DASH_BORED_SKILL_FILES = {
  "SKILL.md": skillMarkdown,
  "agents/openai.yaml": openAiMetadata,
  "references/components.md": componentReference,
} as const;
