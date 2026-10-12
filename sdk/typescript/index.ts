// The TypeScript SDK now lives in the `@warlockcode/agent-viewer-sdk` workspace (`packages/sdk/`, issue #343).
// This file stays as a thin re-export so in-repo tests and examples keep importing `sdk/typescript/index.ts`.
// Inside the repository the root `tsconfig.json` maps the package name to its source, so no build is needed.
export * from '@warlockcode/agent-viewer-sdk';
