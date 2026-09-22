import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

export function validateActionArguments(argsSchema: Record<string, unknown> | undefined, args: Record<string, unknown>): string | undefined {
  if (!argsSchema) return Object.keys(args).length ? "This action does not accept arguments." : undefined;
  try {
    const validate = ajv.compile(argsSchema);
    if (validate(args)) return undefined;
    return ajv.errorsText(validate.errors, { separator: "; " });
  } catch (error) {
    return `The declared action argument schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}
