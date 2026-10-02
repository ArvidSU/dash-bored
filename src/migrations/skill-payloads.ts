/**
 * Legacy migration, scheduled for deletion at dashboard schema v4: skill
 * installs from releases that predate the `skill-version.json` ownership
 * receipt. After v4 a receipt-free install is simply a conflict.
 */
import { skillContentHash } from "../cli/skill-payload";

/** Exact complete receipt-free payloads from published releases.
 * Adopt only a complete matching payload when its ownership receipt is absent.
 * Never infer ownership from a version string or individual matching files.
 */
const LEGACY_SKILL_PAYLOADS: ReadonlyArray<{ version: string; files: Readonly<Record<string, string>> }> = [
  {
    "version": "0.2.2",
    "files": {
      "SKILL.md": "f64be60deddf9de60ec362c9319c1a6ccee14c319799018f69b5751dd63e5881",
      "agents/openai.yaml": "e972aab0ad7c93fe73b73c5af35f8c9b8dfc546c1d6020a94391676a2723dbdf",
      "references/components.md": "341f8f4c78346c20c816d5fefa0a852c8dc6aa9ff0ce25d6e9873c3e73805127"
    }
  },
  {
    "version": "0.2.3",
    "files": {
      "SKILL.md": "cb21110f02fc6d1bc8fb620e972ed2a0e807d0f34cc86915cc36ab8b7e55d8e3",
      "agents/openai.yaml": "e972aab0ad7c93fe73b73c5af35f8c9b8dfc546c1d6020a94391676a2723dbdf",
      "references/components.md": "86e089469c5effe1af2889712c88438ebb884fefecd2c4ff0c7263a39bcc53b1"
    }
  }
];

/**
 * File hashes dash-bored may treat as its own in a receipt-free install: those
 * of the first published payload that every file matches exactly, otherwise
 * none.
 */
export async function adoptLegacySkillPayload(
  readExisting: (relativePath: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  for (const payload of LEGACY_SKILL_PAYLOADS) {
    const matches = await Promise.all(Object.entries(payload.files).map(async ([path, hash]) => {
      const contents = await readExisting(path);
      return contents !== null && skillContentHash(contents) === hash;
    }));
    if (matches.every(Boolean)) return { ...payload.files };
  }
  return {};
}
