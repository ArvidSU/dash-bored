/** Schema-v3 positional action targets; remove with the schema-v4 migration. */
export function isLegacyActionTarget(target: string): boolean {
  return target.includes("${") || /[{}]/.test(target);
}
