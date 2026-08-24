import { readFile, stat } from "node:fs/promises";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";
import type {
  ComponentManifest,
  DashboardConfig,
  DashboardLock,
  Diagnostic,
} from "../shared/contracts";
import { diagnostic, errorMessage } from "./diagnostics";

const MAX_YAML_BYTES = 2 * 1024 * 1024;

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const componentNodeSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["component"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    component: { type: "string", minLength: 1 },
    props: { type: "object" },
    slots: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
      additionalProperties: {
        anyOf: [
          { $ref: "#/$defs/componentNode" },
          {
            type: "array",
            maxItems: 256,
            items: { $ref: "#/$defs/componentNode" },
          },
        ],
      },
    },
  },
};

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "root"],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    root: { $ref: "#/$defs/componentNode" },
  },
  $defs: { componentNode: componentNodeSchema },
} as const;

const lockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lockfileVersion", "components"],
  properties: {
    lockfileVersion: { const: 1 },
    components: { type: "object" },
  },
} as const;

const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name", "description", "entry", "propsSchema"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    entry: { type: "string", pattern: "^\\./", minLength: 3 },
    propsSchema: { type: "object" },
    slots: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          required: { type: "boolean" },
          multiple: { type: "boolean" },
        },
      },
    },
    permissions: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["filesystem:read", "filesystem:write", "network:http", "process:execute"] },
    },
  },
} as const;

const validateConfig = ajv.compile(configSchema);
const validateLock = ajv.compile(lockSchema);
const validateManifest = ajv.compile(manifestSchema);

interface ParsedYaml<T> {
  value: T | null;
  diagnostics: Diagnostic[];
}

function yamlErrorDiagnostic(file: string, error: unknown): Diagnostic {
  const yamlError = error as {
    message?: string;
    linePos?: readonly [{ line: number; col: number }?, ...unknown[]];
  };
  const firstPosition = yamlError.linePos?.[0];
  return diagnostic({
    code: "YAML_INVALID",
    message: yamlError.message ?? errorMessage(error),
    file,
    ...(firstPosition === undefined
      ? {}
      : { line: firstPosition.line, column: firstPosition.col }),
  });
}

function schemaDiagnostics(
  file: string,
  prefix: string,
  errors: ErrorObject[] | null | undefined,
): Diagnostic[] {
  return (errors ?? []).map((error) => {
    const property =
      error.keyword === "additionalProperties"
        ? String(error.params.additionalProperty ?? "")
        : error.keyword === "required"
          ? String(error.params.missingProperty ?? "")
          : "";
    const path = [error.instancePath || "/", property].filter(Boolean).join("/").replaceAll("//", "/");
    return diagnostic({
      code: `${prefix}_SCHEMA_INVALID`,
      message: `${path}: ${error.message ?? "invalid value"}`,
      file,
      path,
    });
  });
}

async function readYaml(file: string): Promise<ParsedYaml<unknown>> {
  let source: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      return {
        value: null,
        diagnostics: [diagnostic({ code: "FILE_NOT_REGULAR", message: "Expected a regular file.", file })],
      };
    }
    if (info.size > MAX_YAML_BYTES) {
      return {
        value: null,
        diagnostics: [
          diagnostic({
            code: "YAML_TOO_LARGE",
            message: `YAML files may not exceed ${MAX_YAML_BYTES} bytes.`,
            file,
          }),
        ],
      };
    }
    source = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      value: null,
      diagnostics: [
        diagnostic({
          code: code === "ENOENT" ? "FILE_NOT_FOUND" : "FILE_READ_FAILED",
          message: code === "ENOENT" ? "Required file does not exist." : errorMessage(error),
          file,
        }),
      ],
    };
  }

  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return { value: null, diagnostics: document.errors.map((error) => yamlErrorDiagnostic(file, error)) };
  }
  if (document.warnings.length > 0) {
    return {
      value: null,
      diagnostics: document.warnings.map((warning) => yamlErrorDiagnostic(file, warning)),
    };
  }

  try {
    return { value: document.toJS({ maxAliasCount: 100 }), diagnostics: [] };
  } catch (error) {
    return { value: null, diagnostics: [yamlErrorDiagnostic(file, error)] };
  }
}

async function parseTyped<T>(
  file: string,
  prefix: string,
  validate: ValidateFunction,
): Promise<ParsedYaml<T>> {
  const parsed = await readYaml(file);
  if (parsed.value === null || parsed.diagnostics.length > 0) {
    return { value: null, diagnostics: parsed.diagnostics };
  }
  if (!validate(parsed.value)) {
    return { value: null, diagnostics: schemaDiagnostics(file, prefix, validate.errors) };
  }
  return { value: parsed.value as T, diagnostics: [] };
}

export async function parseDashboardConfig(file: string): Promise<ParsedYaml<DashboardConfig>> {
  return parseTyped(file, "CONFIG", validateConfig);
}

export function validateDashboardConfigValue(
  value: unknown,
  file = "dash-bored.yaml",
): Diagnostic[] {
  return validateConfig(value)
    ? []
    : schemaDiagnostics(file, "CONFIG", validateConfig.errors);
}

export async function parseDashboardLock(file: string): Promise<ParsedYaml<DashboardLock>> {
  const result = await parseTyped<DashboardLock>(file, "LOCK", validateLock);
  if (result.value !== null && Object.keys(result.value.components).length > 0) {
    return {
      value: null,
      diagnostics: [
        diagnostic({
          code: "LOCK_EXTERNAL_COMPONENTS_UNSUPPORTED",
          message: "External lock-file components are not supported in this milestone.",
          file,
          path: "/components",
        }),
      ],
    };
  }
  return result;
}

export async function parseComponentManifest(file: string): Promise<ParsedYaml<ComponentManifest>> {
  const result = await parseTyped<ComponentManifest>(file, "MANIFEST", validateManifest);
  if (result.value === null) return result;

  try {
    ajv.compile(result.value.propsSchema);
  } catch (error) {
    return {
      value: null,
      diagnostics: [
        diagnostic({
          code: "MANIFEST_PROPS_SCHEMA_INVALID",
          message: errorMessage(error),
          file,
          path: "/propsSchema",
        }),
      ],
    };
  }
  return result;
}

export function validatePropsSchema(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): ErrorObject[] {
  try {
    const validate = ajv.compile(schema);
    return validate(value) ? [] : [...(validate.errors ?? [])];
  } catch (error) {
    return [
      {
        instancePath: "",
        schemaPath: "",
        keyword: "schema",
        params: {},
        message: errorMessage(error),
      },
    ];
  }
}
