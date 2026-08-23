import type { Diagnostic, DiagnosticSeverity } from "../shared/contracts";

export interface DiagnosticInput {
  severity?: DiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  path?: string;
  line?: number;
  column?: number;
}

export function diagnostic(input: DiagnosticInput): Diagnostic {
  return {
    severity: input.severity ?? "error",
    code: input.code,
    message: input.message,
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.line === undefined ? {} : { line: input.line }),
    ...(input.column === undefined ? {} : { column: input.column }),
  };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
  }
}
