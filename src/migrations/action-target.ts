/** Legacy positional action targets, retained until the future atoms migration. */
export function isLegacyActionTarget(target: string): boolean {
  return target.includes("${") || /[{}]/.test(target);
}
