/**
 * Thin re-export of `@warlockcode/agent-viewer-sdk` (issue #343). The package was extracted from this file
 * into `packages/sdk/` so it can be published standalone, with no runtime or type import of
 * `src/integrations/*` or `zod`. Everything that used to live here now lives there, unchanged; existing
 * imports of `sdk/typescript/index.ts` (this repo's own tests, the example adapters) keep working exactly as
 * before.
 */
export * from '@warlockcode/agent-viewer-sdk';
export { default } from '@warlockcode/agent-viewer-sdk';
