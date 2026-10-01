/** Transitional schema-v3 resolver. Remove when the v4 migration is mandatory. */
export function resolveLegacyActionReference(
  reference: string,
  resolvePath: (path: string) => string | undefined,
): string {
  if (!reference.includes("${")) return reference;
  let count = 0;
  const result = reference.replace(/\$\{([^{}]*)\}/g, (_token, path: string) => {
    count += 1;
    if (!/^root(?:\.children(?:\[\d+\]|(?:\.(?:first|second))+)?\.node)*$/.test(path)) {
      throw new Error(`Malformed component node path: ${path || "(empty)"}`);
    }
    const id = resolvePath(path);
    if (id === undefined) throw new Error(`Component node path does not exist: ${path}`);
    return encodeURIComponent(id);
  });
  if (count !== (reference.match(/\$\{/g) ?? []).length || result.includes("${") || /[{}]/.test(result)) {
    throw new Error("Malformed component node path interpolation.");
  }
  return result;
}
