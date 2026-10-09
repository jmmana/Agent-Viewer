/**
 * Shared Claude Code identity: turns a raw Claude Code session id into the same hashed ids everywhere.
 *
 * Used by `cli/claudeHook.ts` (issue #44, the hooks adapter) and by the OTLP logs mapper (issue #59,
 * `src/integrations/otlp/claudeCodeLogs.ts`), so a hook event and a telemetry record from the same session land on the same
 * agent. The raw session id never travels past this function: everything downstream only sees the hash.
 *
 * Moving this out of `cli/claudeHook.ts` does not change its output: `shortHash` and `sessionIdentity` are
 * byte-identical to the versions that used to live there, so existing hook ids (`claude-code-<hash12>`,
 * `claude-<hash12>`) are unchanged.
 *
 * Browser-safe (issue #74): `sha256Hex` (`./sha256.ts`) is a pure-JS SHA-256, not `node:crypto`, because the
 * OTLP logs mapper that calls `sessionIdentity` now has to be importable from `src/lib` for a file dropped in
 * the browser, not only from the server. It produces the exact same digest as `node:crypto`'s SHA-256 (see
 * that file's own doc comment), so every id this module returns is unchanged.
 */
import { sha256Hex } from './sha256.ts';

export function shortHash(value: string, length: number): string {
  return sha256Hex(value).slice(0, length);
}

/** Identity of the agents of one Claude Code session, derived from hashes so raw session ids never travel. */
export function sessionIdentity(sessionId: string) {
  const hash = shortHash(sessionId, 12);
  return {
    sessionId: `claude-code-${hash}`,
    mainAgentId: `claude-${hash}`,
    mainAgentName: `Claude Code ${hash.slice(0, 4)}`,
    subagentId: (agentId: string) => `claude-${hash}-${shortHash(agentId, 8)}`,
    subagentName: (agentType: string, agentId: string) => `${agentType.slice(0, 60)} ${shortHash(agentId, 4)}`,
  };
}

export type ClaudeCodeSessionIdentity = ReturnType<typeof sessionIdentity>;
