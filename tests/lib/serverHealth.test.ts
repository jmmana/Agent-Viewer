import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  fetchServerAuthState,
  SERVER_HEALTH_POLL_MS,
  useServerAuthState,
} from '../../src/integrations/serverHealth';

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchServerAuthState', () => {
  it('maps supported and unknown health responses', async () => {
    for (const [body, expected] of [
      [{ auth: 'open' }, 'open'],
      [{ auth: 'token' }, 'token'],
      [{}, 'unknown'],
      [{ auth: 'unexpected' }, 'unknown'],
    ] as const) {
      await expect(fetchServerAuthState('http://api.test', vi.fn(async () => response(body)) as unknown as typeof fetch))
        .resolves.toBe(expected);
    }
    await expect(fetchServerAuthState('http://api.test', vi.fn(async () => response({}, false)) as unknown as typeof fetch))
      .resolves.toBe('unknown');
    await expect(fetchServerAuthState('http://api.test', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch))
      .resolves.toBe('unknown');
  });
});

describe('useServerAuthState', () => {
  it('does not poll without an API base', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useServerAuthState(undefined));
    expect(result.current).toBe('unknown');
    await act(async () => vi.advanceTimersByTimeAsync(SERVER_HEALTH_POLL_MS));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls every minute without credentials and preserves the last known state on failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ auth: 'open' }))
      .mockResolvedValueOnce(response({ auth: 'token' }))
      .mockRejectedValueOnce(new Error('temporary failure'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useServerAuthState('http://api.test/'));
    await flushPromises();
    expect(result.current).toBe('open');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/health');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('headers');

    await act(async () => vi.advanceTimersByTimeAsync(SERVER_HEALTH_POLL_MS));
    await flushPromises();
    expect(result.current).toBe('token');
    await act(async () => vi.advanceTimersByTimeAsync(SERVER_HEALTH_POLL_MS));
    await flushPromises();
    expect(result.current).toBe('token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('skips overlapping polls and aborts the request when unmounted', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      requestSignal = options?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() => useServerAuthState('http://api.test'));
    await act(async () => vi.advanceTimersByTimeAsync(SERVER_HEALTH_POLL_MS * 2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    unmount();
    expect(requestSignal?.aborted).toBe(true);
  });
});
