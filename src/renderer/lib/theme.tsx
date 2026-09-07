import { useSyncExternalStore } from 'react';
import { BUILTIN_THEME, DARK_TOKENS, parseProjectThemeReference, resolveTheme, themeTokens, type ThemeAppearance, type ThemeCatalogItem, type ThemeMode, type ThemeTokens } from '../../shared/themes';
export interface ResolvedTheme {
  reference: string;
  appearance: ThemeAppearance;
  tokens: ThemeTokens;
  catalog: ThemeCatalogItem[];
  errors: string[];
}
let state: ResolvedTheme = { reference: 'builtin:default', appearance: 'dark', tokens: DARK_TOKENS, catalog: [BUILTIN_THEME], errors: [] };
const listeners = new Set<() => void>();

function sameTokenSet(left: ThemeTokens, right: ThemeTokens): boolean {
  return (Object.keys(left) as Array<keyof ThemeTokens>).every((key) => left[key] === right[key]);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameManifest(left: ThemeCatalogItem['manifest'], right: ThemeCatalogItem['manifest']): boolean {
  if (left === right) return true;
  if (!left || !right || left.schemaVersion !== right.schemaVersion || left.id !== right.id || left.name !== right.name || left.description !== right.description) return false;
  return sameTokenSet({ ...DARK_TOKENS, ...left.light }, { ...DARK_TOKENS, ...right.light })
    && sameTokenSet({ ...DARK_TOKENS, ...left.dark }, { ...DARK_TOKENS, ...right.dark });
}

function sameCatalog(left: ThemeCatalogItem[], right: ThemeCatalogItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    if (!other) return false;
    return item.reference === other.reference
      && item.name === other.name
      && item.displayReference === other.displayReference
      && item.error === other.error
      && item.git?.name === other.git?.name
      && item.git?.url === other.git?.url
      && item.git?.commit === other.git?.commit
      && sameManifest(item.manifest, other.manifest);
  });
}

export function useTheme(): ResolvedTheme {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}
export function applyTheme(catalog: ThemeCatalogItem[], requested: string | undefined, fallback: string | undefined, mode: ThemeMode = 'dark', systemDark = true): void {
  const { item, errors } = resolveTheme(catalog, requested, fallback);
  const appearance = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const tokens = themeTokens(item.manifest!, appearance);
  const next = { reference: item.reference, appearance, tokens, catalog, errors };
  const tokensChanged = !sameTokenSet(state.tokens, tokens);
  const stateChanged = state.reference !== next.reference
    || state.appearance !== next.appearance
    || tokensChanged
    || !sameCatalog(state.catalog, next.catalog)
    || !sameStringList(state.errors, next.errors);
  if (!stateChanged) return;
  // Property assignment cannot introduce selectors, rules, or executable content.
  if (tokensChanged) {
    for (const [name, value] of Object.entries(tokens) as Array<[keyof ThemeTokens, string]>) {
      if (state.tokens[name] !== value) document.documentElement.style.setProperty(`--${name}`, value);
    }
  }
  document.documentElement.style.colorScheme = appearance;
  document.documentElement.dataset.theme = item.reference;
  document.documentElement.dataset.appearance = appearance;
  state = next;
  for (const listener of listeners) listener();
}
export function terminalTheme(tokens: ThemeTokens): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).filter(([key]) => key.startsWith('terminal-')).map(([key, value]) => [key === 'terminal-selection' ? 'selectionBackground' : key.slice(9), value]));
}
export function ThemeSelect({ value, onChange, appDefault = false, inherit = false, dashboardConfigPath, ariaLabel }: { value?: string; onChange: (value: string) => void; appDefault?: boolean; inherit?: boolean; dashboardConfigPath?: string; ariaLabel?: string }) {
  const { catalog } = useTheme();
  const items = catalog.filter((item) => {
    if (appDefault) return !item.reference.startsWith('./');
    if (!dashboardConfigPath) return !item.reference.startsWith('project:');
    const source = parseProjectThemeReference(item.reference);
    return !item.reference.startsWith('project:') || source?.configPath === dashboardConfigPath;
  });
  const optionValue = (item: ThemeCatalogItem): string => {
    if (!dashboardConfigPath) return item.reference;
    return parseProjectThemeReference(item.reference)?.localReference ?? item.reference;
  };
  const selectedValue = value && !items.some((item) => optionValue(item) === value) ? value : value;
  return <select aria-label={ariaLabel ?? (appDefault ? 'Default theme' : 'Dashboard theme')} value={selectedValue ?? (inherit ? '' : 'builtin:default')} onChange={(event) => onChange(event.target.value)}>
    {inherit && <option value="">Use app default</option>}
    {value && !items.some((item) => optionValue(item) === value) && <option value={value}>{value} (unavailable)</option>}
    {items.map((item) => <option key={item.reference} value={optionValue(item)} disabled={!item.manifest}>{item.name} — {item.displayReference ?? item.reference}{item.error ? ' (unavailable)' : ''}</option>)}
  </select>;
}
export function ThemeNotice() {
  const { errors } = useTheme();
  return errors.length ? <div className="theme-notice" role="status">Theme unavailable; using a fallback. {errors.join(' ')}</div> : null;
}
