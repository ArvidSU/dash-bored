import Ajv, { type ValidateFunction } from "ajv";

const MAX_COMPILED_SCHEMAS = 256;
const compiledSchemas = new Map<string, ValidateFunction>();
const createCompiler = () => new Ajv({ allErrors: true, strict: false, validateFormats: false });
let ajv = createCompiler();
let compilationCount = 0;

/** Reuse freshly parsed schemas without retaining every dashboard reload in Ajv. */
export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = compiledSchemas.get(key);
  if (cached) return cached;
  // removeSchema does not release Ajv's generated-code scope. Bound that too,
  // including failed compilations, by periodically replacing the compiler.
  if (compilationCount >= MAX_COMPILED_SCHEMAS) {
    ajv = createCompiler();
    compilationCount = 0;
  }
  compilationCount += 1;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } finally {
    // Ajv caches by object identity, including schemas whose compilation fails.
    // Keep object-identity registrations out of the long-lived compiler.
    ajv.removeSchema(schema);
  }
  if (compiledSchemas.size >= MAX_COMPILED_SCHEMAS) {
    const oldest = compiledSchemas.keys().next().value;
    if (oldest !== undefined) compiledSchemas.delete(oldest);
  }
  compiledSchemas.set(key, validate);
  return validate;
}
