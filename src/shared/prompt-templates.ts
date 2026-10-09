import type { AgentPromptScope, AgentPromptTemplateSummary, Diagnostic } from "./contracts";

export const PROMPTS_DIRECTORY = "prompts";
export const BUILTIN_PROMPT_PREFIX = "dash-bored/";
export const DEFAULT_PROMPT_TEMPLATE = "project";
const MAX_PARTIAL_DEPTH = 8;
/** Context roots every template may reference; `vars` and `env` keys are checked separately. */
const CONTEXT_ROOTS = new Set(["input", "vars", "varList", "hasVars", "env", "project", "dashboard", "component"]);

export interface PromptTemplate {
  name: string;
  description: string;
  scope: AgentPromptScope;
  input: "required" | "optional";
  /** Declared variables and their descriptions; `null` accepts any variable. */
  vars: Readonly<Record<string, string>> | null;
  env: readonly string[];
  body: string;
  /** Absolute source file, absent for built-ins. */
  file?: string;
  builtin: boolean;
}

export interface PromptTemplateSet {
  /** Effective templates by name: bundle files override built-ins of the same name. */
  templates: ReadonlyMap<string, PromptTemplate>;
  diagnostics: Diagnostic[];
}

export interface PromptContext {
  input: string;
  vars: Readonly<Record<string, string | number | boolean>>;
  env: Readonly<Record<string, string>>;
  project: { root: string; name: string };
  dashboard: { config: string; directory: string };
  component: { id: string; reference: string; path: string; name: string };
}

const BUILTIN_TEMPLATES: readonly PromptTemplate[] = [
  {
    name: "project",
    description: "Do work in the project, requested from its dashboard.",
    scope: "project",
    input: "required",
    vars: null,
    env: [],
    builtin: true,
    body: [
      "You were asked to do work in this project from its dash-bored dashboard.",
      "The request is about the project itself, not the dashboard configuration, unless it explicitly says otherwise. Inspect the project and follow its own instructions (for example AGENTS.md or CLAUDE.md) before changing anything, preserve unrelated changes, and verify the result the way the project expects.",
      "Project root: {{project.root}}",
      "Requested from: {{component.name}} (component `{{component.id}}`, {{component.reference}}) in {{dashboard.config}}",
      "{{#hasVars}}",
      "Context:",
      "{{/hasVars}}",
      "{{#varList}}",
      "- {{name}}: {{value}}",
      "{{/varList}}",
      "",
      "Request:",
      "{{input}}",
    ].join("\n"),
  },
  {
    name: "dashboard",
    description: "Change the dashboard, starting from one of its components.",
    scope: "dashboard",
    input: "required",
    vars: null,
    env: [],
    builtin: true,
    body: [
      "You are changing a dash-bored dashboard from one of its components.",
      "Interpret the request in the dash-bored product and component-tree model. Inspect the project and its instructions before editing, use the installed dash-bored skill when available, preserve unrelated changes, and validate the result.",
      "Project root: {{project.root}}",
      "Owning dashboard config: {{dashboard.config}}",
      "Target component path: {{component.path}}",
      "Target component id: {{component.id}}",
      "Target component reference: {{component.reference}}",
      "{{#hasVars}}",
      "Context:",
      "{{/hasVars}}",
      "{{#varList}}",
      "- {{name}}: {{value}}",
      "{{/varList}}",
      "",
      "User request:",
      "{{input}}",
    ].join("\n"),
  },
];

export function builtinPromptTemplates(): ReadonlyMap<string, PromptTemplate> {
  return new Map(BUILTIN_TEMPLATES.map((template) => [template.name, template]));
}

/** Find a template by name; `dash-bored/<name>` always means the shipped default. */
export function resolvePromptTemplate(
  templates: ReadonlyMap<string, PromptTemplate>,
  name: string = DEFAULT_PROMPT_TEMPLATE,
): PromptTemplate | undefined {
  return name.startsWith(BUILTIN_PROMPT_PREFIX)
    ? builtinPromptTemplates().get(name.slice(BUILTIN_PROMPT_PREFIX.length))
    : templates.get(name);
}

export function promptTemplateSummary(template: PromptTemplate): AgentPromptTemplateSummary {
  return {
    name: template.name,
    description: template.description,
    scope: template.scope,
    input: template.input,
    builtin: template.builtin,
    vars: template.vars === null ? null : { ...template.vars },
  };
}

/** The effective templates a composer can pick from: built-ins first, then bundle names. */
export function promptTemplateSummaries(templates: ReadonlyMap<string, PromptTemplate>): AgentPromptTemplateSummary[] {
  return [...templates.values()]
    .sort((left, right) => Number(right.builtin) - Number(left.builtin) || left.name.localeCompare(right.name))
    .map(promptTemplateSummary);
}

// ---------------------------------------------------------------------------
// Parsing: a logic-less Mustache subset. Prompts are plain text, so values are
// never escaped, and standalone section lines vanish with their line break.

export type PromptTemplateToken =
  | { type: "text"; value: string }
  | { type: "variable"; name: string }
  | { type: "section"; name: string; inverted: boolean; children: PromptTemplateToken[] }
  | { type: "partial"; name: string };

export function parsePromptTemplate(source: string): PromptTemplateToken[] {
  const root: PromptTemplateToken[] = [];
  const stack: Array<{ name: string; inverted: boolean; children: PromptTemplateToken[] }> = [];
  const current = () => stack.at(-1)?.children ?? root;
  const tag = /\{\{\s*([#^/>]?)\s*([^{}]*?)\s*\}\}/g;
  let cursor = 0;
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    const [raw, sigil = "", name = ""] = match;
    let start = match.index;
    let end = start + raw.length;
    if (sigil !== "") {
      // A section, closing, or partial tag alone on its line removes that line.
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const newline = source.indexOf("\n", end);
      const lineEnd = newline === -1 ? source.length : newline;
      if (source.slice(lineStart, start).trim() === "" && source.slice(end, lineEnd).trim() === "") {
        start = Math.max(lineStart, cursor);
        // An include keeps its line break, since included bodies end without one.
        end = newline === -1 || sigil === ">" ? lineEnd : newline + 1;
      }
    }
    if (start > cursor) current().push({ type: "text", value: source.slice(cursor, start) });
    cursor = end;
    if (name === "") throw new Error(`Empty template tag at offset ${match.index}.`);
    if (sigil === "#" || sigil === "^") {
      const section = { name, inverted: sigil === "^", children: [] as PromptTemplateToken[] };
      current().push({ type: "section", ...section });
      stack.push(section);
    } else if (sigil === "/") {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Unexpected closing tag {{/${name}}}.`);
    } else if (sigil === ">") {
      current().push({ type: "partial", name });
    } else {
      current().push({ type: "variable", name });
    }
  }
  if (cursor < source.length) current().push({ type: "text", value: source.slice(cursor) });
  const unclosed = stack.at(-1);
  if (unclosed) throw new Error(`Section {{#${unclosed.name}}} is never closed.`);
  return root;
}

/**
 * Report references a template cannot satisfy. Inside sections, names may refer
 * to the section's own values (for example `name` within `varList`), so only
 * top-level names and every `vars.`/`env.` reference are checked.
 */
export function checkPromptTemplateReferences(
  template: PromptTemplate,
  tokens: readonly PromptTemplateToken[],
  templates: ReadonlyMap<string, PromptTemplate>,
  depth = 0,
): string[] {
  const problems: string[] = [];
  const check = (name: string) => {
    const [root, key] = name.split(".");
    if (root === "vars" && key !== undefined && template.vars !== null && !Object.hasOwn(template.vars, key)) {
      problems.push(`{{${name}}} uses a variable that is not declared in vars.`);
    } else if (root === "env" && key !== undefined && !template.env.includes(key)) {
      problems.push(`{{${name}}} uses an environment value that is not declared in env.`);
    } else if (depth === 0 && !CONTEXT_ROOTS.has(root ?? "")) {
      problems.push(`{{${name}}} is not a known prompt value.`);
    }
  };
  for (const token of tokens) {
    if (token.type === "variable") check(token.name);
    else if (token.type === "section") {
      check(token.name);
      problems.push(...checkPromptTemplateReferences(template, token.children, templates, depth + 1));
    } else if (token.type === "partial" && resolvePartial(token.name, template, templates) === null) {
      problems.push(`{{> ${token.name}}} names an unknown template.`);
    }
  }
  return problems;
}

function resolvePartial(
  name: string,
  from: PromptTemplate,
  templates: ReadonlyMap<string, PromptTemplate>,
): PromptTemplate | null {
  if (name.startsWith(BUILTIN_PROMPT_PREFIX)) {
    return builtinPromptTemplates().get(name.slice(BUILTIN_PROMPT_PREFIX.length)) ?? null;
  }
  const template = templates.get(name);
  // A bundle override that includes its own name means the default it replaced.
  if (template === from && !from.builtin) return builtinPromptTemplates().get(name) ?? null;
  return template ?? null;
}

/** Check one `agent:prompt` invocation against the bundle's templates. */
export function validatePromptInvocation(
  templates: ReadonlyMap<string, PromptTemplate>,
  args: Record<string, unknown>,
): string | undefined {
  const name = typeof args.template === "string" ? args.template : DEFAULT_PROMPT_TEMPLATE;
  const template = resolvePromptTemplate(templates, name);
  if (!template) return `prompt template ${JSON.stringify(name)} is not defined; add ${PROMPTS_DIRECTORY}/${name}.md or use project or dashboard.`;
  const vars = args.vars !== null && typeof args.vars === "object" ? Object.keys(args.vars) : [];
  const undeclared = template.vars === null ? [] : vars.filter((key) => !Object.hasOwn(template.vars!, key));
  if (undeclared.length > 0) return `prompt template ${JSON.stringify(name)} does not declare vars: ${undeclared.join(", ")}.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering.

type Scope = unknown;

function lookup(stack: readonly Scope[], name: string): unknown {
  const [head, ...rest] = name.split(".");
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const scope = stack[index];
    if (scope !== null && typeof scope === "object" && Object.hasOwn(scope, head!)) {
      let value: unknown = (scope as Record<string, unknown>)[head!];
      for (const key of rest) {
        value = value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
      }
      return value;
    }
  }
  return undefined;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

function renderTokens(
  tokens: readonly PromptTemplateToken[],
  stack: Scope[],
  template: PromptTemplate,
  templates: ReadonlyMap<string, PromptTemplate>,
  depth: number,
): string {
  let output = "";
  for (const token of tokens) {
    if (token.type === "text") output += token.value;
    else if (token.type === "variable") {
      const value = lookup(stack, token.name);
      if (value !== undefined && value !== null && typeof value !== "object") output += String(value);
    } else if (token.type === "section") {
      const value = lookup(stack, token.name);
      if (token.inverted) {
        if (!truthy(value)) output += renderTokens(token.children, stack, template, templates, depth);
      } else if (Array.isArray(value)) {
        for (const entry of value) output += renderTokens(token.children, [...stack, entry], template, templates, depth);
      } else if (truthy(value)) {
        output += renderTokens(token.children, [...stack, value], template, templates, depth);
      }
    } else {
      const partial = resolvePartial(token.name, template, templates);
      if (!partial) throw new Error(`{{> ${token.name}}} names an unknown template.`);
      if (depth >= MAX_PARTIAL_DEPTH) throw new Error(`Prompt template includes nest deeper than ${MAX_PARTIAL_DEPTH} levels.`);
      output += renderTokens(parsePromptTemplate(partial.body), stack, partial, templates, depth + 1);
    }
  }
  return output;
}

export function renderPromptTemplate(
  template: PromptTemplate,
  templates: ReadonlyMap<string, PromptTemplate>,
  context: PromptContext,
): string {
  const env = Object.fromEntries(template.env.filter((key) => Object.hasOwn(context.env, key)).map((key) => [key, context.env[key]!]));
  const scope = {
    ...context,
    env,
    varList: Object.entries(context.vars).map(([name, value]) => ({ name, value })),
    hasVars: Object.keys(context.vars).length > 0,
  };
  const rendered = renderTokens(parsePromptTemplate(template.body), [scope], template, templates, 0);
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

export interface AgentPromptRequest {
  /** Template name; `project` when omitted. */
  template?: string;
  input: string;
  vars?: Readonly<Record<string, unknown>>;
  projectRoot: string;
  configPath: string;
  configDirectory: string;
  component: PromptContext["component"];
  /** Resolved launch environment; only keys the template declares are rendered. */
  env?: Readonly<Record<string, string>>;
  /** Previews render before the user has typed a required request. */
  allowEmptyInput?: boolean;
}

/** Choose, check, and render one agent request. Throws a user-facing Error when it cannot be sent. */
export function prepareAgentPrompt(
  set: PromptTemplateSet,
  request: AgentPromptRequest,
): { template: PromptTemplate; prompt: string } {
  const name = request.template ?? DEFAULT_PROMPT_TEMPLATE;
  const template = resolvePromptTemplate(set.templates, name);
  if (!template) throw new Error(`Prompt template ${JSON.stringify(name)} is not defined; add ${PROMPTS_DIRECTORY}/${name}.md or use project or dashboard.`);
  const problem = template.file === undefined
    ? undefined
    : set.diagnostics.find((item) => item.file === template.file && item.severity === "error");
  if (problem) throw new Error(`Prompt template ${template.file} is invalid: ${problem.message}`);
  const vars: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(request.vars ?? {})) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Prompt variable ${key} must be a string, number, or boolean.`);
    }
    vars[key] = value;
  }
  const invalid = validatePromptInvocation(set.templates, { template: name, vars });
  if (invalid) throw new Error(`The ${invalid}`);
  const input = request.input.trim();
  if (template.input === "required" && input === "" && request.allowEmptyInput !== true) throw new Error(`Prompt template ${name} needs a request.`);
  const prompt = renderPromptTemplate(template, set.templates, {
    input,
    vars,
    env: request.env ?? {},
    project: { root: request.projectRoot, name: request.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? request.projectRoot },
    dashboard: { config: request.configPath, directory: request.configDirectory },
    component: request.component,
  });
  return { template, prompt };
}
