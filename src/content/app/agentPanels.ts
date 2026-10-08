/**
 * Demo app texts (not the library) for this area, in English and Spanish.
 * The keys are merged into the app catalog in `src/i18n.ts`. Placeholders use `{name}` and are filled by
 * `t(locale, key, params)`.
 */

const EN = {} as const satisfies Record<string, string>;

const ES: Record<keyof typeof EN, string> = {};

export const AGENT_PANELS_MESSAGES = { en: EN, es: ES };
