# Instructions for coding agents

Agent Viewer is an open-source observability product for AI agents: a live office (React 19 + Canvas2D) that shows what agents do, and an audit trail of what their model calls consume. Build it as a production product, never as a throwaway demo.

## Before writing code

1. Read the assigned issue completely. Roadmap issues (label `roadmap`) are the specification: problem, proposal, acceptance criteria, tests, docs, out of scope, dependencies and effort. Do exactly what they say, nothing more.
2. Read the release epic linked from the issue (label `epic`, one per milestone) for the goal and the exit criteria.
3. Check the issue's dependencies. If a hard dependency is still open, stop and say so in the PR instead of building on top of code that does not exist yet.
4. Work on one branch per issue, from `main`, and open one PR per issue with `Closes #N`.

## Repository layout

| Path | What lives there |
|---|---|
| `src/lib/` | The embeddable library `@warlockcode/agent-viewer` (public API in `src/lib/index.ts`) |
| `src/integrations/` | Canonical event contract V1, validation, ingestion, log parser, realtime client |
| `src/engine/` | Office state, living office engine, canvas renderer, layout |
| `src/components/`, `src/App.tsx` | Demo app |
| `src/content/` | Text catalogs and demo scenario |
| `server/` | Express 5 ingestion server (`index.ts`) and event store (`store.ts`, memory or SQLite) |
| `sdk/python/`, `sdk/typescript/` | SDKs |
| `tests/*.test.mjs` | node:test suites (server, contract, SDKs) |
| `tests/lib/` | Vitest suites (library, engine, catalogs) |
| `docs/` | Guides; `docs/README.es.md` is the Spanish README |

## Commands

Use Node 24 (`.nvmrc`) and install with `npm ci`. These are the CI checks; run all of them before asking for review and paste the exact results in the PR:

```bash
npm audit --omit=dev
npm run lint                     # tsc --noEmit
npm test                         # node:test suites and Vitest
python3 tests/test_python_sdk.py
npm run build                    # demo app
npm run build:lib                # library
npm run check:package            # publint and attw
```

Run a single suite with `npx tsx --test tests/<name>.test.mjs` or `npx vitest run tests/lib/<name>.test.ts`. If you touch `sdk/python/`, also build and install the wheel as CI does (`python3 -m pip wheel ./sdk/python -w /tmp/wheels`). If you touch `docker/`, run the two Docker builds from CI or say in the PR that you could not.

## Product rules

- **Unknown is never zero.** A token count, cost or currency that was not reported stays unknown. Never default it to `0`, never add unknown values as if they were zero, and never add amounts in different currencies.
- **The library never computes usage.** `<AgentOffice>` shows only the figures the host passes in `usage`; `showUsage` is `false` by default. The library never prices tokens.
- **Professional mode is the default.** The office shows only what the events say. Simulated life exists only in `mode="showcase"` and is always marked as simulated. Never mix simulated data with real data.
- **Observable data only.** Never add features that require or expose private model reasoning.
- **Audit trail.** Every change to spend or usage must come from an event that is stored. Do not add endpoints that mutate figures without one.
- **Contract changes.** The event contract is versioned. A breaking change needs the `breaking-change` label on the issue, a compatibility note and a CHANGELOG entry.

## Code rules

- TypeScript strict, small focused modules, no `any` where a type exists.
- Express 5 route syntax (named wildcards such as `/*splat`).
- The library has no side effects on import, no `localStorage`, no global listeners and no global CSS; every class starts with `av-`.
- Every logic change comes with tests. Do not claim a test passed if you did not run it.
- Touch only the files the issue needs. If you must change something shared, explain why in the PR.
- Do not add dependencies unless the issue asks for it.

## Texts and languages

- English is the source locale and Spanish the first secondary one. Every visible text exists in both.
- Demo app texts live in `src/i18n.ts` and `src/content/app/*.ts`; library texts in `src/content/officeMessages.ts` (`OFFICE_MESSAGES`). Add every new key in English and Spanish.
- Docs that have a Spanish twin are updated together: `README.md` with `docs/README.es.md`, `docs/library.md` with `docs/library.es.md`, and any new `docs/x.md` with `docs/x.es.md` when the issue asks for it.
- Never use the em dash character (U+2014) in code, docs, commits or PRs.

## CHANGELOG and PRs

- Add your entry under `## [Unreleased]` at the top of `CHANGELOG.md` (create the section if it does not exist), in the right group: Added, Changed, Fixed, Removed or Breaking changes.
- Fill in `.github/PULL_REQUEST_TEMPLATE.md`: summary, changes, the commands you ran with their results, and what is left.
- Never merge a PR, never push to `main`, never create tags or releases, never force-push.
- No secrets and no real customer or user data, in code, tests or fixtures.

## Open work to respect

PR #42 (`feat/cli-and-claude-code`, issue #44) is open and adds the CLI, the GHCR image and the Claude Code hooks adapter. It also edits `server/index.ts`. Do not copy its changes into your branch; keep your change small so whichever lands second can rebase easily.
