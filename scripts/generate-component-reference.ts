/**
 * Renders the built-in component reference (skills/dash-bored/references/builtins.md)
 * from BUILTIN_COMPONENTS in src/core/builtins.ts. The output is deterministic
 * (manifest order, no timestamps, trailing newline) and committed; a drift test
 * regenerates it in memory and fails when it diverges from the catalog.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listBuiltinManifests } from "../src/core/builtins";
import type { ComponentManifest } from "../src/shared/contracts";

type Schema = Record<string, any>;

const TARGET_PATH = resolve(import.meta.dirname, "../skills/dash-bored/references/builtins.md");
const REGENERATION_COMMAND = "bun run generate:components";

function backtick(value: unknown): string {
  return `\`${String(value)}\``;
}

function renderType(schema: Schema | undefined): string {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => backtick(value)).join(" \\| ");
  }
  const type = schema.type;
  if (Array.isArray(type)) return type.join(" \\| ");
  if (type === "array") return `array of ${renderType(schema.items)}`;
  if (type === "object") {
    const additional = schema.additionalProperties;
    if (additional && typeof additional === "object") {
      return `map of string to ${renderType(additional)}`;
    }
    return "object";
  }
  return typeof type === "string" ? type : "any";
}

function renderRange(min: unknown, max: unknown, unit: string): string | null {
  const hasMin = typeof min === "number";
  const hasMax = typeof max === "number";
  const suffix = unit ? ` ${unit}` : "";
  if (hasMin && hasMax) return `${min}–${max}${suffix}`;
  if (hasMin) return `>= ${min}${suffix}`;
  if (hasMax) return `<= ${max}${suffix}`;
  return null;
}

function renderObjectSummary(schema: Schema): string {
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (!properties) return "object";
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  return (
    "object with keys: " +
    Object.entries(properties)
      .map(([name, child]) => {
        const marker = required.includes(name) ? " (required)" : "";
        return `${backtick(name)}${marker} ${renderType(child)}`;
      })
      .join(", ")
  );
}

function renderNotes(schema: Schema): string[] {
  const notes: string[] = [];
  const range = renderRange(schema.minimum, schema.maximum, "");
  if (range) notes.push(range);
  const items = renderRange(schema.minItems, schema.maxItems, "items");
  if (items) notes.push(items);
  if (schema.minLength) notes.push("non-empty");
  if (schema.pattern) notes.push(`must match ${backtick(schema.pattern)}`);
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    if (schema.items.type === "object" && schema.items.properties) {
      notes.push(renderObjectSummary(schema.items));
    }
    const itemRange = renderRange(schema.items.minimum, schema.items.maximum, "");
    if (itemRange) notes.push(`item values ${itemRange}`);
  }
  if (schema.type === "object" && schema.properties) {
    notes.push(renderObjectSummary(schema));
  }
  return notes;
}

interface AnyOfNote {
  alternatives: string[];
}

function anyOfNote(schema: Schema): AnyOfNote | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const alternatives = schema.anyOf
    .map((branch: Schema) => (Array.isArray(branch.required) ? branch.required : []))
    .filter((required: string[]) => required.length > 0)
    .map((required: string[]) => required.map((name) => backtick(name)).join(" + "));
  if (alternatives.length === 0) return null;
  return { alternatives: [...new Set(alternatives)] };
}

function renderPropsTable(manifest: ComponentManifest): string[] {
  const schema = manifest.propsSchema as Schema;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const oneOf = anyOfNote(schema);
  const names = Object.keys(properties);
  const lines: string[] = ["Props:", ""];
  if (names.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Prop | Type | Required | Notes |", "| --- | --- | --- | --- |");
    for (const name of names) {
      const prop = properties[name] as Schema;
      const type = renderType(prop);
      let requiredCell = required.includes(name) ? "yes" : "no";
      const notes = renderNotes(prop);
      if (oneOf?.alternatives.some((alternative) => alternative.includes(backtick(name)))) {
        requiredCell = "see note";
      }
      lines.push(`| ${backtick(name)} | ${type} | ${requiredCell} | ${notes.join("; ")} |`);
    }
  }
  if (oneOf) {
    lines.push("", `Exactly one of ${oneOf.alternatives.join(" or ")} is required.`);
  }
  return lines;
}

function renderChildren(manifest: ComponentManifest): string[] {
  const children = manifest.children;
  if (!children) return ["Children: none (leaf component)."];
  const presentation = children.presentation as Schema;
  const isManaged = presentation?.type === "managed";
  const presentationLabel = isManaged
    ? "managed presentation"
    : `tiled presentation (axes: ${backtick(presentation?.axes ?? "both")})`;
  const cardinality =
    children.max === undefined
      ? `minimum ${children.min}`
      : children.min === children.max
        ? `exactly ${children.min}`
        : `${children.min}–${children.max} children`;
  const lines = [`Children: ${presentationLabel}, ${cardinality}.`];
  const metadataSchema = children.metadataSchema as Schema | undefined;
  if (metadataSchema?.properties) {
    lines.push(`Edge metadata: ${renderObjectSummary(metadataSchema)}.`);
  }
  return lines;
}

function renderPermissions(manifest: ComponentManifest): string {
  if (!manifest.permissions || manifest.permissions.length === 0) {
    return "Permissions: none.";
  }
  return `Permissions: ${manifest.permissions.map((permission) => backtick(permission)).join(", ")}.`;
}

function renderResources(manifest: ComponentManifest): string[] {
  const process = manifest.resources?.process as Schema | undefined;
  if (!process) return [];
  const parts: string[] = [];
  if (process.commandProp) parts.push(`command from ${backtick(process.commandProp)}`);
  if (process.cwdProp) parts.push(`working directory from ${backtick(process.cwdProp)}`);
  if (process.envProp) parts.push(`environment from ${backtick(process.envProp)}`);
  if (process.interactive) parts.push("interactive PTY");
  return ["Resources:", "", `- \`process\`: ${parts.join(", ")}.`];
}

function renderComponent(manifest: ComponentManifest): string[] {
  return [
    `${manifest.name} — ${manifest.description}`,
    "",
    ...renderPropsTable(manifest),
    "",
    ...renderChildren(manifest),
    "",
    renderPermissions(manifest),
    "",
    ...renderResources(manifest),
    "",
  ];
}

export function generateComponentReference(): string {
  const manifests = listBuiltinManifests();
  const lines: string[] = [
    "<!-- GENERATED FILE — do not edit by hand.",
    `     Regenerate with: ${REGENERATION_COMMAND} -->`,
    "",
    "# Built-in component reference",
    "",
    "Generated from `BUILTIN_COMPONENTS` in `src/core/builtins.ts`; this file",
    "ships inside the dash-bored skill for this version. Types come from each",
    "component's JSON Schema `propsSchema`.",
    "",
  ];
  for (const manifest of manifests) {
    lines.push(`## ${manifest.id}`, "", ...renderComponent(manifest));
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

if (import.meta.main) {
  await mkdir(dirname(TARGET_PATH), { recursive: true });
  await writeFile(TARGET_PATH, generateComponentReference());
  console.log(`Wrote ${TARGET_PATH}`);
}
