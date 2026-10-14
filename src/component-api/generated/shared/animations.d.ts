/**
 * Public v1 attention-animation contract. An animation is bounded keyframe
 * data the renderer plays on a component frame; never CSS or code.
 */
export declare const ANIMATION_COLORS: readonly ["accent", "info", "positive", "warning", "negative"];
export type AnimationColor = typeof ANIMATION_COLORS[number];
export declare const ANIMATION_EASINGS: readonly ["linear", "ease", "ease-in", "ease-out", "ease-in-out"];
export type AnimationEasing = typeof ANIMATION_EASINGS[number];
/** Bounds shared by the schema, the parser, and the renderer. */
export declare const ANIMATION_LIMITS: {
    readonly translate: 48;
    readonly rotate: 30;
    readonly scale: {
        readonly min: 0.5;
        readonly max: 1.5;
    };
    readonly opacity: {
        readonly min: 0.25;
        readonly max: 1;
    };
    readonly duration: {
        readonly min: 100;
        readonly max: 2000;
    };
    readonly iterations: {
        readonly min: 1;
        readonly max: 4;
    };
    /** One request never animates longer than this, so attention cannot become continuous motion. */
    readonly totalMs: 4000;
    readonly keyframes: {
        readonly min: 2;
        readonly max: 24;
    };
};
/** Channels a keyframe omits are at rest: no offset, no rotation, scale 1, opacity 1, no glow. */
export interface AnimationKeyframe {
    /** Position in one iteration, 0–1; omitted offsets are spaced evenly. */
    at?: number;
    /** Horizontal and vertical offset in CSS pixels. */
    x?: number;
    y?: number;
    /** Degrees. */
    rotate?: number;
    scale?: number;
    opacity?: number;
    /** Halo intensity, 0–1, in the animation's `color` token. */
    glow?: number;
    /** Timing from this keyframe to the next; defaults to the animation's `easing`. */
    easing?: AnimationEasing;
}
export interface AnimationManifest {
    schemaVersion: 1;
    id: string;
    name: string;
    description?: string;
    /** Milliseconds per iteration. */
    duration: number;
    iterations?: number;
    easing?: AnimationEasing;
    /** Theme token the glow uses; defaults to `accent`. */
    color?: AnimationColor;
    keyframes: AnimationKeyframe[];
}
export interface AnimationCatalogItem {
    reference: string;
    name: string;
    manifest?: AnimationManifest;
    error?: string;
}
export declare const ANIMATION_REFERENCE_PATTERN = "^(?:builtin:[A-Za-z][A-Za-z0-9_-]*|global:[A-Za-z][A-Za-z0-9_-]*|\\./animations/[A-Za-z][A-Za-z0-9_-]*)$";
export declare function isAnimationReference(reference: string): boolean;
/** Played when an attention request names no animation and the dashboard sets no `attentionAnimation`. */
export declare const DEFAULT_ANIMATION_REFERENCE = "builtin:bounce";
/** Animations shipped with the app; every catalog starts with these. */
export declare const BUILTIN_ANIMATIONS: readonly AnimationCatalogItem[];
export declare function builtinAnimation(reference: string): AnimationManifest | undefined;
export declare const ANIMATION_SCHEMA: {
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
        duration: {
            type: string;
            minimum: 100;
            maximum: 2000;
        };
        iterations: {
            type: string;
            minimum: 1;
            maximum: 4;
        };
        easing: {
            enum: ("linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out")[];
        };
        color: {
            enum: ("accent" | "positive" | "warning" | "negative" | "info")[];
        };
        keyframes: {
            type: string;
            minItems: 2;
            maxItems: 24;
            items: {
                type: string;
                additionalProperties: boolean;
                minProperties: number;
                properties: {
                    at: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    x: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    y: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    rotate: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    scale: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    opacity: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    glow: {
                        type: string;
                        minimum: number;
                        maximum: number;
                    };
                    easing: {
                        enum: ("linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out")[];
                    };
                };
            };
        };
    };
};
/** Rules the JSON Schema cannot express. Returns one message per problem. */
export declare function animationProblems(manifest: AnimationManifest): string[];
export interface PlayableAnimation {
    keyframes: Keyframe[];
    timing: {
        duration: number;
        iterations: number;
        easing: 'linear';
    };
}
/**
 * Translate a manifest into Web Animations keyframes. The glow is composed in
 * front of the element's own `baseShadow`, so the frame keeps its shadow, and
 * follows `radius`, the corners of the surface the frame wraps.
 * Reduced motion drops movement; an animation with nothing left plays the
 * built-in glow instead.
 */
export declare function playableAnimation(manifest: AnimationManifest, options: {
    reducedMotion: boolean;
    glowRgb: string;
    baseShadow?: string;
    radius?: string;
}): PlayableAnimation;
/** `#rrggbb` or `#rrggbbaa` (theme color tokens) to an `r, g, b` triple. */
export declare function hexToRgbTriple(value: string): string | undefined;
