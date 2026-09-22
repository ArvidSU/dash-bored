import type { ActionInvocation } from "./contracts";

export function actionInvocation(value: unknown): { run: string; with: Record<string, unknown> } | undefined {
  if (typeof value === "string") return { run: value, with: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const invocation = value as Partial<Extract<ActionInvocation, object>>;
  if (typeof invocation.run !== "string" || !invocation.run.trim()) return undefined;
  if (invocation.with !== undefined && (!invocation.with || typeof invocation.with !== "object" || Array.isArray(invocation.with))) return undefined;
  return { run: invocation.run, with: invocation.with ?? {} };
}
