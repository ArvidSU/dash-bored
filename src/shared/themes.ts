/** Public v1 design-token contract. Values are data, never CSS source. */
export const DARK_TOKENS = {
  bg: '#0a0c10', surface: '#101319', 'surface-raised': '#161a22', 'surface-hover': '#1b202a',
  border: '#252b36', 'border-bright': '#343c49', text: '#e8edf5', muted: '#8e99a9', faint: '#5d6674',
  accent: '#d9ff68', 'accent-strong': '#bfe839', 'accent-ink': '#151b03',
  'accent-soft': '#31401b', 'panel-dark': '#0a0c10', 'panel-dark-muted': '#161a22',
  'border-dark': '#343c49', highlight: '#ffffff14',
  'shadow-color': '#000000', positive: '#70e2a0', warning: '#f4c66b', negative: '#ff7b7b', info: '#8fb8ff',
  'font-ui': 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'font-mono': '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  'radius-sm': '7px', radius: '11px', 'radius-lg': '17px', shadow: '0px 18px 60px 0px #00000047',
  'terminal-background': '#080a0d', 'terminal-foreground': '#c2c9d2', 'terminal-cursor': '#d9ff68',
  'terminal-selection': '#31401b',
  'terminal-black': '#1b202a', 'terminal-red': '#ff7b7b', 'terminal-green': '#70e2a0',
  'terminal-yellow': '#f4c66b', 'terminal-blue': '#8fb8ff', 'terminal-magenta': '#d19aff',
  'terminal-cyan': '#77dce8', 'terminal-white': '#c2c9d2',
  'terminal-brightBlack': '#5d6674', 'terminal-brightRed': '#ff9b9b', 'terminal-brightGreen': '#95efb8',
  'terminal-brightYellow': '#ffdf99', 'terminal-brightBlue': '#b1ceff', 'terminal-brightMagenta': '#e2bbff',
  'terminal-brightCyan': '#a1edf5', 'terminal-brightWhite': '#e8edf5',
  'chart-1': '#d9ff68', 'chart-2': '#8fb8ff', 'chart-3': '#f4c66b', 'chart-4': '#d19aff',
  'chart-5': '#70e2a0', 'chart-6': '#ff9b9b',
};
export type ThemeTokens = typeof DARK_TOKENS;
export type ThemeToken = keyof ThemeTokens;
export type ThemeAppearance = 'light' | 'dark';
export type ThemeMode = ThemeAppearance | 'system';
const THEME_PACKAGE_PATH = String.raw`\.\/themes(?:\/external)?\/[A-Za-z][A-Za-z0-9_-]*`;
const THEME_PACKAGE_PATH_PATTERN = new RegExp(`^${THEME_PACKAGE_PATH}$`);
const APP_THEME_REFERENCE_PATTERN = new RegExp(`^(?:builtin:default|global:[A-Za-z][A-Za-z0-9_-]*|project:[^:]+:${THEME_PACKAGE_PATH})$`);
const LEGACY_APP_THEME_REFERENCE_PATTERN = new RegExp(`^${THEME_PACKAGE_PATH}$`);

/** Stable app-level reference for a theme installed below a registered dashboard bundle. */
export function projectThemeReference(configPath: string, localReference: string): string {
  if (!THEME_PACKAGE_PATH_PATTERN.test(localReference)) throw new Error(`Invalid local theme reference: ${localReference}`);
  return `project:${encodeURIComponent(configPath)}:${localReference}`;
}

export function parseProjectThemeReference(reference: string): { configPath: string; localReference: string } | null {
  const match = /^project:([^:]+):(\.\/themes(?:\/external)?\/[A-Za-z][A-Za-z0-9_-]*)$/.exec(reference);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { configPath: decodeURIComponent(match[1]), localReference: match[2] };
  } catch {
    return null;
  }
}

export function isAppThemeReference(reference: string): boolean {
  return APP_THEME_REFERENCE_PATTERN.test(reference) || LEGACY_APP_THEME_REFERENCE_PATTERN.test(reference);
}

export interface ThemeManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  light: Partial<ThemeTokens>;
  dark: Partial<ThemeTokens>;
}
export interface ThemeCatalogItem {
  git?: { name: string; url: string; commit: string };
  /** Human-readable source shown when an app-level reference is qualified. */
  displayReference?: string;
  reference: string;
  name: string;
  manifest?: ThemeManifest;
  error?: string;
}
export const LIGHT_TOKENS: ThemeTokens = {
  ...DARK_TOKENS,
  bg: '#f4f6fa', surface: '#ffffff', 'surface-raised': '#edf0f5', 'surface-hover': '#e3e8ef',
  border: '#d3dbe5', 'border-bright': '#aab6c5', text: '#18212e', muted: '#526176', faint: '#657389',
  accent: '#486500', 'accent-strong': '#354d00', 'accent-ink': '#ffffff',
  'accent-soft': '#cbdcb0', 'panel-dark': '#18212e', 'panel-dark-muted': '#2c3644',
  'border-dark': '#657389', highlight: '#ffffff',
  positive: '#167345', warning: '#886000', negative: '#be303b', info: '#285fbb',
  shadow: '0px 18px 60px 0px #18212e24',
  'terminal-background': '#f8fafc', 'terminal-foreground': '#18212e', 'terminal-cursor': '#486500',
  'terminal-selection': '#cbdcb0', 'terminal-black': '#18212e', 'terminal-red': '#ad2334',
  'terminal-green': '#17663b', 'terminal-yellow': '#805700', 'terminal-blue': '#285fbb',
  'terminal-magenta': '#843ea3', 'terminal-cyan': '#08717d', 'terminal-white': '#526176',
  'terminal-brightBlack': '#657389', 'terminal-brightRed': '#be303b', 'terminal-brightGreen': '#167345',
  'terminal-brightYellow': '#886000', 'terminal-brightBlue': '#3271cd', 'terminal-brightMagenta': '#9844b9',
  'terminal-brightCyan': '#087d8b', 'terminal-brightWhite': '#18212e',
  'chart-1': '#486500', 'chart-2': '#285fbb', 'chart-3': '#886000', 'chart-4': '#843ea3',
  'chart-5': '#167345', 'chart-6': '#be303b',
};
export const BUILTIN_THEME: ThemeCatalogItem = {
  reference: 'builtin:default', name: 'dash-bored',
  manifest: { schemaVersion: 1, id: 'default', name: 'dash-bored', light: {}, dark: {} },
};
export function resolveTheme(catalog: ThemeCatalogItem[], requested: string | undefined, fallback = 'builtin:default') {
  const references = [...new Set([requested, fallback, 'builtin:default'].filter(Boolean))] as string[];
  const errors: string[] = [];
  for (const reference of references) {
    const item = reference === 'builtin:default' ? BUILTIN_THEME : catalog.find((item) => item.reference === reference);
    if (item?.manifest) return { item, errors };
    errors.push(`${reference}: ${item?.error ?? 'Theme not installed. Use dash-bored theme list or sync.'}`);
  }
  return { item: BUILTIN_THEME, errors };
}
export function themeTokens(manifest: ThemeManifest, appearance: ThemeAppearance): ThemeTokens {
  return { ...(appearance === 'light' ? LIGHT_TOKENS : DARK_TOKENS), ...manifest[appearance] };
}
const color = { type: 'string', pattern: '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };
export const THEME_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'id', 'name', 'light', 'dark'],
  properties: {
    schemaVersion: { const: 1 }, id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', maxLength: 80 },
    name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', maxLength: 1000 },
    ...Object.fromEntries(['light', 'dark'].map((mode) => [mode, {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.keys(DARK_TOKENS).map((key) => [key,
        key.startsWith('font-') ? { type: 'string', minLength: 1, maxLength: 300, pattern: '^[A-Za-z0-9 ,"\\x27_-]+$' }
          : key.startsWith('radius') ? { type: 'string', pattern: '^(?:[0-9]|[12][0-9]|3[0-2])px$' }
          : key === 'shadow' ? { type: 'string', pattern: '^(?:none|(?:-?[0-9]{1,2}px ){2}(?:[0-9]{1,2}px ){2}#[0-9a-fA-F]{8})$' }
          : color])),
    }])),
  },
};
