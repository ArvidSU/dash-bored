import Ajv, { type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const MAX_COMPILED_SCHEMAS = 256;
const compiledSchemas = new Map<string, ValidateFunction>();

/**
 * Compile an action argument schema once per distinct content. Ajv caches by
 * object identity, and every config load parses fresh schema objects.
 */
export function compileActionArgsSchema(argsSchema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(argsSchema);
  const cached = compiledSchemas.get(key);
  if (cached) return cached;
  const validate = ajv.compile(argsSchema);
  ajv.removeSchema(argsSchema);
  if (compiledSchemas.size >= MAX_COMPILED_SCHEMAS) {
    const oldest = compiledSchemas.keys().next().value;
    if (oldest !== undefined) compiledSchemas.delete(oldest);
  }
  compiledSchemas.set(key, validate);
  return validate;
}

export function validateActionArguments(argsSchema: Record<string, unknown> | undefined, args: Record<string, unknown>): string | undefined {
  if (!argsSchema) return Object.keys(args).length ? "This action does not accept arguments." : undefined;
  try {
    const validate = compileActionArgsSchema(argsSchema);
    if (validate(args)) return undefined;
    return ajv.errorsText(validate.errors, { separator: "; " });
  } catch (error) {
    return `The declared action argument schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Validate list item placeholders against declared action argument types. */
export function validateActionArgumentTemplates(
  argsSchema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string | undefined {
  try {
    const value = substituteTemplateSamples(args, argsSchema ?? { type: "object" });
    if (!value || typeof value !== "object" || Array.isArray(value)) return "Action arguments must resolve to an object.";
    return validateActionArguments(argsSchema, value as Record<string, unknown>);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function substituteTemplateSamples(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const match = /^\$\{item\.([A-Za-z][A-Za-z0-9_-]*)\}$/.exec(value);
    if (match) return schemaSample(schema);
    if (value.includes("${item.")) throw new Error("Item templates must be the full value of an action argument.");
    return value;
  }
  if (Array.isArray(value)) {
    const itemSchema = schema.items && typeof schema.items === "object" ? schema.items as Record<string, unknown> : {};
    return value.map((entry) => substituteTemplateSamples(entry, itemSchema));
  }
  if (value !== null && typeof value === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown>
      : {};
    const additional = schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? schema.additionalProperties as Record<string, unknown>
      : {};
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      const childSchema = properties[key] && typeof properties[key] === "object"
        ? properties[key] as Record<string, unknown>
        : additional;
      return [key, substituteTemplateSamples(entry, childSchema)];
    }));
  }
  return value;
}

function schemaSample(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (alternatives?.length && alternatives[0] && typeof alternatives[0] === "object") {
    return schemaSample(alternatives[0] as Record<string, unknown>);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== "null") : schema.type;
  switch (type) {
    case "string": return "item-value";
    case "integer":
    case "number": return 1;
    case "boolean": return true;
    case "array": return [];
    case "object": return {};
    default: throw new Error("Item template argument needs a declared JSON Schema type.");
  }
}
