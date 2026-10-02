/**
 * Legacy migration, scheduled for deletion at dashboard schema v4: an app
 * default theme saved as a bare `./themes/<name>` path, which meant "that
 * package in whichever dashboard is open". Main pins it to the active
 * dashboard's package when app settings are read; until then the reference
 * stays readable and resolves against the active dashboard.
 *
 * Pure so main (rewrite) and the renderer (re-read trigger) share one test.
 */
import { parseProjectThemeReference, type ThemeCatalogItem } from "../shared/themes";

const LEGACY_APP_THEME_REFERENCE = /^\.\/themes(?:\/external)?\/[A-Za-z][A-Za-z0-9_-]*$/;

export function isLegacyAppThemeReference(reference: string | undefined): reference is string {
  return reference !== undefined && LEGACY_APP_THEME_REFERENCE.test(reference);
}

/** The stable `project:` reference for a legacy app theme, once the active dashboard provides it. */
export function upgradeLegacyAppThemeReference(
  reference: string | undefined,
  activeConfigPath: string | null | undefined,
  catalog: readonly ThemeCatalogItem[],
): string | undefined {
  if (!isLegacyAppThemeReference(reference) || !activeConfigPath) return undefined;
  return catalog.find((item) => {
    const source = parseProjectThemeReference(item.reference);
    return source?.configPath === activeConfigPath && source.localReference === reference;
  })?.reference;
}
