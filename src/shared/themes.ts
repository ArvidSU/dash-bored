/** Public v1 design-token contract. Values are data, never CSS source. */
export const DARK_TOKENS = {
  bg: '#0a0f17', surface: '#151d2a', 'surface-raised': '#1e2939', 'surface-hover': '#283549',
  border: '#2e3a4d', 'border-bright': '#50607a', text: '#edf2fa', muted: '#a9b5c8', faint: '#8d9bb1',
  accent: '#a8c8ff', 'accent-strong': '#80acfa', 'accent-ink': '#101c30',
  'accent-soft': '#273e61', 'panel-dark': '#0a0c10', 'panel-dark-muted': '#161a22',
  'border-dark': '#343c49', highlight: '#ffffff14',
  'shadow-color': '#000000', positive: '#70e2a0', warning: '#f4c66b', negative: '#ff7b7b', info: '#c4a6ff',
  'font-ui': 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'font-mono': '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  'radius-sm': '7px', radius: '11px', 'radius-lg': '17px', shadow: '0px 18px 60px 0px #00000047',
  'terminal-background': '#080a0d', 'terminal-foreground': '#c2c9d2', 'terminal-cursor': '#a8c8ff',
  'terminal-selection': '#273e61',
  'terminal-black': '#1b202a', 'terminal-red': '#ff7b7b', 'terminal-green': '#70e2a0',
  'terminal-yellow': '#f4c66b', 'terminal-blue': '#8fb8ff', 'terminal-magenta': '#d19aff',
  'terminal-cyan': '#77dce8', 'terminal-white': '#c2c9d2',
  'terminal-brightBlack': '#5d6674', 'terminal-brightRed': '#ff9b9b', 'terminal-brightGreen': '#95efb8',
  'terminal-brightYellow': '#ffdf99', 'terminal-brightBlue': '#b1ceff', 'terminal-brightMagenta': '#e2bbff',
  'terminal-brightCyan': '#a1edf5', 'terminal-brightWhite': '#e8edf5',
  'chart-1': '#a8c8ff', 'chart-2': '#77dce8', 'chart-3': '#f4c66b', 'chart-4': '#d19aff',
  'chart-5': '#70e2a0', 'chart-6': '#ff9b9b',
};
export type ThemeTokens = typeof DARK_TOKENS;
export type ThemeToken = keyof ThemeTokens;
export type ThemeAppearance = 'light' | 'dark';
export type ThemeMode = ThemeAppearance | 'system';
const THEME_PACKAGE_PATH = String.raw`\.\/themes(?:\/external)?\/[A-Za-z][A-Za-z0-9_-]*`;
const THEME_PACKAGE_PATH_PATTERN = new RegExp(`^${THEME_PACKAGE_PATH}$`);
const APP_THEME_REFERENCE_PATTERN = new RegExp(`^(?:builtin:[A-Za-z][A-Za-z0-9_-]*|global:[A-Za-z][A-Za-z0-9_-]*|project:[^:]+:${THEME_PACKAGE_PATH})$`);
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
  bg: '#e8ecf2', surface: '#ffffff', 'surface-raised': '#f2f5f9', 'surface-hover': '#e6ebf2',
  border: '#cfd7e2', 'border-bright': '#98a5b8', text: '#141c28', muted: '#4a586c', faint: '#5b6a7f',
  accent: '#285fbb', 'accent-strong': '#17458f', 'accent-ink': '#ffffff',
  'accent-soft': '#dbe7fa', 'panel-dark': '#18212e', 'panel-dark-muted': '#2c3644',
  'border-dark': '#657389', highlight: '#ffffff',
  positive: '#167345', warning: '#8a5a00', negative: '#be303b', info: '#6b46c1',
  shadow: '0px 18px 60px 0px #18212e24',
  'terminal-background': '#f8fafc', 'terminal-foreground': '#18212e', 'terminal-cursor': '#285fbb',
  'terminal-selection': '#dbe7fa', 'terminal-black': '#18212e', 'terminal-red': '#ad2334',
  'terminal-green': '#17663b', 'terminal-yellow': '#805700', 'terminal-blue': '#285fbb',
  'terminal-magenta': '#843ea3', 'terminal-cyan': '#08717d', 'terminal-white': '#526176',
  'terminal-brightBlack': '#657389', 'terminal-brightRed': '#be303b', 'terminal-brightGreen': '#167345',
  'terminal-brightYellow': '#886000', 'terminal-brightBlue': '#3271cd', 'terminal-brightMagenta': '#9844b9',
  'terminal-brightCyan': '#087d8b', 'terminal-brightWhite': '#18212e',
  'chart-1': '#285fbb', 'chart-2': '#08717d', 'chart-3': '#886000', 'chart-4': '#843ea3',
  'chart-5': '#167345', 'chart-6': '#be303b',
};
export const BUILTIN_THEME: ThemeCatalogItem = {
  reference: 'builtin:default', name: 'dash-bored',
  manifest: { schemaVersion: 1, id: 'default', name: 'dash-bored', light: {}, dark: {} },
};
/** Synthwave dusk: plum surfaces, a hot-magenta signal accent, and cyan info kept apart from it. */
export const NEON_DUSK_THEME: ThemeCatalogItem = {
  reference: 'builtin:neon-dusk', name: 'Neon Dusk',
  manifest: {
    schemaVersion: 1, id: 'neon-dusk', name: 'Neon Dusk',
    description: 'Synthwave plum surfaces with a hot-magenta accent, cyan info, and a soft neon glow.',
    light: {
      bg: '#ece4f5', surface: '#fdfaff', 'surface-raised': '#f5effb', 'surface-hover': '#ebe2f5',
      border: '#d8cce8', 'border-bright': '#a796c2', text: '#1d1230', muted: '#5a4a75', faint: '#6c5c88',
      accent: '#b5179e', 'accent-strong': '#8e0f7b', 'accent-ink': '#ffffff', 'accent-soft': '#f7d6ef',
      'panel-dark': '#1c1230', 'panel-dark-muted': '#2e2047', 'border-dark': '#6c5c88', highlight: '#ffffff',
      'shadow-color': '#1d1230', positive: '#0f7a52', warning: '#8a5a00', negative: '#c0283f', info: '#0b6f8f',
      shadow: '0px 18px 60px 0px #b5179e1f',
      'terminal-background': '#fbf7ff', 'terminal-foreground': '#1d1230', 'terminal-cursor': '#b5179e',
      'terminal-selection': '#f7d6ef', 'terminal-black': '#1d1230', 'terminal-red': '#b3203a',
      'terminal-green': '#0f6e4a', 'terminal-yellow': '#7d5600', 'terminal-blue': '#3b4fc4',
      'terminal-magenta': '#a3168e', 'terminal-cyan': '#08708a', 'terminal-white': '#5a4a75',
      'terminal-brightBlack': '#6c5c88', 'terminal-brightRed': '#c0283f', 'terminal-brightGreen': '#0f7a52',
      'terminal-brightYellow': '#8a5a00', 'terminal-brightBlue': '#4a5fd6', 'terminal-brightMagenta': '#b5179e',
      'terminal-brightCyan': '#0b7d9b', 'terminal-brightWhite': '#1d1230',
      'chart-1': '#b5179e', 'chart-2': '#0b6f8f', 'chart-3': '#8a5a00', 'chart-4': '#5b3fc4',
      'chart-5': '#0f7a52', 'chart-6': '#c0283f',
    },
    dark: {
      bg: '#120b1f', surface: '#1c1230', 'surface-raised': '#261a40', 'surface-hover': '#31224f',
      border: '#3a2a5c', 'border-bright': '#5e4a8a', text: '#f6eefe', muted: '#c3b3dc', faint: '#a593c4',
      accent: '#ff7ad9', 'accent-strong': '#ff4fc8', 'accent-ink': '#2a0620', 'accent-soft': '#4d1d4a',
      'panel-dark': '#0b0614', 'panel-dark-muted': '#170f26', 'border-dark': '#3d2d5a', highlight: '#ffffff12',
      'shadow-color': '#000000', positive: '#5cf2b4', warning: '#ffd166', negative: '#ff6b81', info: '#6ee7ff',
      shadow: '0px 18px 60px 0px #ff2fb026',
      'terminal-background': '#0b0614', 'terminal-foreground': '#e6dcf5', 'terminal-cursor': '#ff7ad9',
      'terminal-selection': '#4d1d4a', 'terminal-black': '#1c1230', 'terminal-red': '#ff6b81',
      'terminal-green': '#5cf2b4', 'terminal-yellow': '#ffd166', 'terminal-blue': '#8c9eff',
      'terminal-magenta': '#ff7ad9', 'terminal-cyan': '#6ee7ff', 'terminal-white': '#e6dcf5',
      'terminal-brightBlack': '#6a5a8c', 'terminal-brightRed': '#ff97a8', 'terminal-brightGreen': '#8ff7cc',
      'terminal-brightYellow': '#ffe19a', 'terminal-brightBlue': '#b3c0ff', 'terminal-brightMagenta': '#ffa6e6',
      'terminal-brightCyan': '#a4f0ff', 'terminal-brightWhite': '#fbf7ff',
      'chart-1': '#ff7ad9', 'chart-2': '#6ee7ff', 'chart-3': '#ffd166', 'chart-4': '#b69cff',
      'chart-5': '#5cf2b4', 'chart-6': '#ff9e6b',
    },
  },
};
/** Themes shipped with the app; every catalog starts with these. */
export const BUILTIN_THEMES: readonly ThemeCatalogItem[] = [BUILTIN_THEME, NEON_DUSK_THEME];
export function resolveTheme(catalog: ThemeCatalogItem[], requested: string | undefined, fallback = 'builtin:default') {
  const references = [...new Set([requested, fallback, 'builtin:default'].filter(Boolean))] as string[];
  const errors: string[] = [];
  for (const reference of references) {
    const item = BUILTIN_THEMES.find((builtin) => builtin.reference === reference) ?? catalog.find((item) => item.reference === reference);
    if (item?.manifest) return { item, errors };
    errors.push(`${reference}: ${item?.error ?? 'Theme not installed. Sync theme packages in Settings → Themes.'}`);
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
