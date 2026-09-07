import { useSyncExternalStore } from 'react';
import { BUILTIN_THEME, DARK_TOKENS, resolveTheme, themeTokens, type ThemeAppearance, type ThemeCatalogItem, type ThemeMode, type ThemeTokens } from '../../shared/themes';
export interface ResolvedTheme {
  reference: string;
  appearance: ThemeAppearance;
  tokens: ThemeTokens;
  catalog: ThemeCatalogItem[];
  errors: string[];
}
let state: ResolvedTheme = { reference: 'builtin:default', appearance: 'dark', tokens: DARK_TOKENS, catalog: [BUILTIN_THEME], errors: [] };
const listeners = new Set<() => void>();
export function useTheme(): ResolvedTheme {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}
export function applyTheme(catalog: ThemeCatalogItem[], requested: string | undefined, fallback: string | undefined, mode: ThemeMode = 'dark', systemDark = true): void {
  const { item, errors } = resolveTheme(catalog, requested, fallback);
  const appearance = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const tokens = themeTokens(item.manifest!, appearance);
  const next = { reference: item.reference, appearance, tokens, catalog, errors };
  if (JSON.stringify(state) === JSON.stringify(next)) return;
  // Property assignment cannot introduce selectors, rules, or executable content.
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${name}`, value);
  document.documentElement.style.colorScheme = appearance;
  document.documentElement.dataset.theme = item.reference;
  document.documentElement.dataset.appearance = appearance;
  state = next;
  for (const listener of listeners) listener();
}
export function terminalTheme(tokens: ThemeTokens): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).filter(([key]) => key.startsWith('terminal-')).map(([key, value]) => [key === 'terminal-selection' ? 'selectionBackground' : key.slice(9), value]));
}
export function ThemeSelect({ value, onChange, personal = false, inherit = false }: { value?: string; onChange: (value: string) => void; personal?: boolean; inherit?: boolean }) {
  const { catalog } = useTheme();
  const items = catalog.filter((item) => !personal || !item.reference.startsWith('./'));
  return <select aria-label={personal ? 'Default theme' : 'Dashboard theme'} value={value ?? (inherit ? '' : 'builtin:default')} onChange={(event) => onChange(event.target.value)}>
    {inherit && <option value="">Use app default</option>}
    {value && !items.some((item) => item.reference === value) && <option value={value}>{value} (unavailable)</option>}
    {items.map((item) => <option key={item.reference} value={item.reference} disabled={!item.manifest}>{item.name} — {item.reference}{item.error ? ' (unavailable)' : ''}</option>)}
  </select>;
}
export function ThemeNotice() {
  const { errors } = useTheme();
  return errors.length ? <div className="theme-notice" role="status">Theme unavailable; using a fallback. {errors.join(' ')}</div> : null;
}
