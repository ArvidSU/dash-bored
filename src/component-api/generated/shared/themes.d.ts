/** Public v1 design-token contract. Values are data, never CSS source. */
export declare const DARK_TOKENS: {
    bg: string;
    surface: string;
    'surface-raised': string;
    'surface-hover': string;
    border: string;
    'border-bright': string;
    text: string;
    muted: string;
    faint: string;
    accent: string;
    'accent-strong': string;
    'accent-ink': string;
    'accent-soft': string;
    'panel-dark': string;
    'panel-dark-muted': string;
    'border-dark': string;
    highlight: string;
    'shadow-color': string;
    positive: string;
    warning: string;
    negative: string;
    info: string;
    'font-ui': string;
    'font-mono': string;
    'radius-sm': string;
    radius: string;
    'radius-lg': string;
    shadow: string;
    'terminal-background': string;
    'terminal-foreground': string;
    'terminal-cursor': string;
    'terminal-selection': string;
    'terminal-black': string;
    'terminal-red': string;
    'terminal-green': string;
    'terminal-yellow': string;
    'terminal-blue': string;
    'terminal-magenta': string;
    'terminal-cyan': string;
    'terminal-white': string;
    'terminal-brightBlack': string;
    'terminal-brightRed': string;
    'terminal-brightGreen': string;
    'terminal-brightYellow': string;
    'terminal-brightBlue': string;
    'terminal-brightMagenta': string;
    'terminal-brightCyan': string;
    'terminal-brightWhite': string;
    'chart-1': string;
    'chart-2': string;
    'chart-3': string;
    'chart-4': string;
    'chart-5': string;
    'chart-6': string;
};
export type ThemeTokens = typeof DARK_TOKENS;
export type ThemeToken = keyof ThemeTokens;
export type ThemeAppearance = 'light' | 'dark';
export type ThemeMode = ThemeAppearance | 'system';
/** Stable app-level reference for a theme installed below a registered dashboard bundle. */
export declare function projectThemeReference(configPath: string, localReference: string): string;
export declare function parseProjectThemeReference(reference: string): {
    configPath: string;
    localReference: string;
} | null;
export declare function isAppThemeReference(reference: string): boolean;
export interface ThemeManifest {
    schemaVersion: 1;
    id: string;
    name: string;
    description?: string;
    light: Partial<ThemeTokens>;
    dark: Partial<ThemeTokens>;
}
export interface ThemeCatalogItem {
    git?: {
        name: string;
        url: string;
        commit: string;
    };
    /** Human-readable source shown when an app-level reference is qualified. */
    displayReference?: string;
    reference: string;
    name: string;
    manifest?: ThemeManifest;
    error?: string;
}
export declare const LIGHT_TOKENS: ThemeTokens;
export declare const BUILTIN_THEME: ThemeCatalogItem;
/** Synthwave dusk: plum surfaces, a hot-magenta signal accent, and cyan info kept apart from it. */
export declare const NEON_DUSK_THEME: ThemeCatalogItem;
/** Themes shipped with the app; every catalog starts with these. */
export declare const BUILTIN_THEMES: readonly ThemeCatalogItem[];
export declare function resolveTheme(catalog: ThemeCatalogItem[], requested: string | undefined, fallback?: string): {
    item: ThemeCatalogItem;
    errors: string[];
};
export declare function themeTokens(manifest: ThemeManifest, appearance: ThemeAppearance): ThemeTokens;
export declare const THEME_SCHEMA: {
    $schema: string;
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        schemaVersion: {
            const: number;
        };
        id: {
            type: string;
            pattern: string;
            maxLength: number;
        };
        name: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        description: {
            type: string;
            maxLength: number;
        };
    };
};
