/**
 * Tests for `useServerApi` (issue #88, sub-issue #332): the hook that turns the portal's already-resolved
 * connection info (same `{ baseUrl, token, tokenResolved }` shape `useModelOpsLedger`'s `LedgerConnection`
 * already established for the ledger client, issue #79) into a `ServerApi`, or `null` in demo mode / while the
 * token is still resolving, so no request is ever sent without a chance for a real token to reach it first.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useServerApi } from '../../src/integrations/useServerApi';

describe('useServerApi', () => {
  it('returns null when there is no connection (demo mode, no apiBase)', () => {
    const { result } = renderHook(() => useServerApi(null));
    expect(result.current).toBeNull();
  });

  it('returns null while the token has not finished resolving, even with an apiBase', () => {
    const { result } = renderHook(() => useServerApi({ baseUrl: 'https://server.example', token: undefined, tokenResolved: false }));
    expect(result.current).toBeNull();
  });

  it('returns a usable ServerApi once the token has resolved, even to no token (open server)', () => {
    const { result } = renderHook(() => useServerApi({ baseUrl: 'https://server.example', token: undefined, tokenResolved: true }));
    expect(result.current).not.toBeNull();
    expect(typeof result.current?.getBudgets).toBe('function');
  });

  it('returns a usable ServerApi with a resolved token', () => {
    const { result } = renderHook(() => useServerApi({ baseUrl: 'https://server.example', token: 'tok-123', tokenResolved: true }));
    expect(result.current).not.toBeNull();
  });

  it('memoizes the client across re-renders with the same connection values', () => {
    const connection = { baseUrl: 'https://server.example', token: 'tok-123', tokenResolved: true };
    const { result, rerender } = renderHook(({ conn }) => useServerApi(conn), { initialProps: { conn: connection } });
    const first = result.current;
    rerender({ conn: { ...connection } });
    expect(result.current).toBe(first);
  });
});
