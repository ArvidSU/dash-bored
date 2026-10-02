import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentPromptScope, Diagnostic } from "../shared/contracts";
import {
  builtinPromptTemplates,
  checkPromptTemplateReferences,
  parsePromptTemplate,
  PROMPTS_DIRECTORY,
  type PromptTemplate,
  type PromptTemplateSet,
} from "../shared/prompt-templates";
import { diagnostic } from "./diagnostics";

export * from "../shared/prompt-templates";

const MAX_PROMPT_TEMPLATES = 64;
const MAX_PROMPT_TEMPLATE_BYTES = 32 * 1024;
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FRONTMATTER_KEYS = new Set(["description", "scope", "input", "vars", "env"]);

function frontmatterError(file: string, message: string): Diagnostic {
  return diagnostic({ code: "PROMPT_TEMPLATE_INVALID", message, file });
}

export function parsePromptTemplateFile(
  name: string,
  file: string,
  source: string,
): { template: PromptTemplate | null; diagnostics: Diagnostic[] } {
  const fail = (message: string) => ({ template: null, diagnostics: [frontmatterError(file, message)] });
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  let meta: unknown = {};
  let body = source;
  if (match) {
    try {
      meta = parse(match[1] ?? "") ?? {};
    } catch (error) {
      return fail(`Prompt template frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    body = match[2] ?? "";
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return fail("Prompt template frontmatter must be a mapping.");
  const record = meta as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !FRONTMATTER_KEYS.has(key));
  if (unknown.length > 0) return fail(`Unknown prompt template fields: ${unknown.join(", ")}.`);
  if (record.description !== undefined && typeof record.description !== "string") return fail("description must be a string.");
  if (record.scope !== undefined && record.scope !== "project" && record.scope !== "dashboard") {
    return fail("scope must be project or dashboard.");
  }
  if (record.input !== undefined && record.input !== "required" && record.input !== "optional") {
    return fail("input must be required or optional.");
  }
  let vars: Record<string, string> = {};
  if (record.vars !== undefined) {
    if (record.vars === null || typeof record.vars !== "object" || Array.isArray(record.vars)) {
      return fail("vars must map variable names to descriptions.");
    }
    for (const [key, value] of Object.entries(record.vars)) {
      if (!VARIABLE_NAME.test(key)) return fail(`Variable name ${JSON.stringify(key)} must start with a letter and use letters, digits, or underscores.`);
      if (typeof value !== "string") return fail(`vars.${key} must be a description string.`);
    }
    vars = { ...(record.vars as Record<string, string>) };
  }
  if (record.env !== undefined && (!Array.isArray(record.env) || record.env.some((key) => typeof key !== "string" || !ENV_NAME.test(key)))) {
    return fail("env must be a list of environment variable names.");
  }
  if (body.trim() === "") return fail("Prompt template body is empty.");
  try {
    parsePromptTemplate(body);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return {
    template: {
      name,
      description: typeof record.description === "string" ? record.description : "",
      scope: (record.scope as AgentPromptScope | undefined) ?? "project",
      input: (record.input as PromptTemplate["input"] | undefined) ?? "required",
      vars,
      env: [...((record.env as string[] | undefined) ?? [])],
      body,
      file,
      builtin: false,
    },
    diagnostics: [],
  };
}

/** Load built-in and bundle prompt templates; a missing `prompts/` folder is normal. */
export async function loadPromptTemplates(configDirectory: string): Promise<PromptTemplateSet> {
  const templates = new Map(builtinPromptTemplates());
  const diagnostics: Diagnostic[] = [];
  const directory = join(configDirectory, PROMPTS_DIRECTORY);
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((entry) => entry.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { templates, diagnostics };
    }
    return { templates, diagnostics: [frontmatterError(directory, `Prompt templates could not be read: ${(error as Error).message}`)] };
  }
  if (entries.length > MAX_PROMPT_TEMPLATES) {
    diagnostics.push(frontmatterError(directory, `A bundle may define at most ${MAX_PROMPT_TEMPLATES} prompt templates.`));
    entries = entries.slice(0, MAX_PROMPT_TEMPLATES);
  }
  const loaded: PromptTemplate[] = [];
  for (const entry of entries) {
    const name = entry.slice(0, -".md".length);
    const file = join(directory, entry);
    if (!TEMPLATE_NAME.test(name)) {
      diagnostics.push(frontmatterError(file, "Prompt template file names must be lowercase letters, digits, and hyphens."));
      continue;
    }
    // Symlinks could reach outside the bundle; templates are plain files only.
    const info = await lstat(file);
    if (!info.isFile()) {
      diagnostics.push(frontmatterError(file, "Prompt templates must be regular files."));
      continue;
    }
    if (info.size > MAX_PROMPT_TEMPLATE_BYTES) {
      diagnostics.push(frontmatterError(file, `Prompt templates may be at most ${MAX_PROMPT_TEMPLATE_BYTES} bytes.`));
      continue;
    }
    const parsed = parsePromptTemplateFile(name, file, await readFile(file, "utf8"));
    diagnostics.push(...parsed.diagnostics);
    if (parsed.template) {
      templates.set(name, parsed.template);
      loaded.push(parsed.template);
    }
  }
  for (const template of loaded) {
    for (const message of checkPromptTemplateReferences(template, parsePromptTemplate(template.body), templates)) {
      diagnostics.push(frontmatterError(template.file!, message));
    }
  }
  return { templates, diagnostics };
}

