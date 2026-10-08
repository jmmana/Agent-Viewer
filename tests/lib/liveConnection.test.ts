import { describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_PATH,
  LIVE_TOKEN_STORAGE_KEY,
  addressWithoutCredentials,
  loadLiveToken,
  resolveLiveConnection,
  takeLiveCredentials,
  type BrowserLike,
} from '../../src/integrations/liveConnection';

const page = (search = '', hash = '') => ({ origin: 'http://127.0.0.1:8787', search, hash });

describe('resolveLiveConnection', () => {
  it('uses the page origin when the office is served by the agent-viewer CLI', () => {
    expect(resolveLiveConnection(page('?mode=live', '#token=abc'), 'same-origin', true)).toEqual({
      apiBase: 'http://127.0.0.1:8787',
      token: 'abc',
    });
  });

  it('keeps the previous behavior without the CLI', () => {
    expect(resolveLiveConnection(page(), undefined, true)).toEqual({ apiBase: 'http://localhost:8787', token: undefined });
    expect(resolveLiveConnection(page(), undefined, false)).toEqual({ apiBase: undefined, token: undefined });
    expect(resolveLiveConnection(page(), 'http://api.example:9000', false).apiBase).toBe('http://api.example:9000');
  });

  it('reads the token from the fragment first, then from the query', () => {
    expect(resolveLiveConnection(page('?token=q'), 'same-origin', true).token).toBe('q');
    expect(resolveLiveConnection(page('?token=q', '#token=h'), 'same-origin', true).token).toBe('h');
    expect(resolveLiveConnection(page('', '#token=a%2Bb'), 'same-origin', true).token).toBe('a+b');
  });
});

function fakeBrowser(search: string, hash: string, stored?: string) {
  const items = new Map<string, string>(stored ? [[LIVE_TOKEN_STORAGE_KEY, stored]] : []);
  const replaced: string[] = [];
  const win: BrowserLike = {
    location: { origin: 'http://127.0.0.1:8787', pathname: '/', search, hash },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
        replaced.push(String(url));
        const next = new URL(String(url), 'http://127.0.0.1:8787');
        win.location.search = next.search;
        win.location.hash = next.hash;
      },
    },
    sessionStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
    },
  };
  return { win, replaced, items };
}

describe('token in the address bar', () => {
  it('removes #token and ?token from the address as soon as they are read, keeping the rest', () => {
    const { win, replaced, items } = fakeBrowser('?mode=live&token=q', '#token=abc&view=office');
    expect(takeLiveCredentials(win)).toEqual({ token: 'abc', launchCode: undefined });
    expect(replaced).toEqual(['/?mode=live#view=office']);
    expect(win.location.hash).not.toContain('token');
    expect(win.location.search).toBe('?mode=live');
    expect(items.get(LIVE_TOKEN_STORAGE_KEY)).toBe('abc');
  });

  it('keeps working after a reload of the same tab, from session storage', () => {
    const { win, replaced } = fakeBrowser('?mode=live', '', 'stored');
    expect(takeLiveCredentials(win).token).toBe('stored');
    expect(replaced).toEqual([]);
  });

  it('leaves an address without credentials alone', () => {
    expect(addressWithoutCredentials({ origin: '', pathname: '/', search: '?mode=live', hash: '#x=1' })).toBeUndefined();
    expect(addressWithoutCredentials({ origin: '', pathname: '/office', search: '?token=t', hash: '#launch=c' })).toBe('/office');
  });
});

describe('launch code', () => {
  it('trades the single-use code for the token once, and cleans it from the address', async () => {
    const { win, replaced, items } = fakeBrowser('?mode=live', '#launch=code-1');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'granted' }), { status: 200 }));
    const [first, second] = await Promise.all([
      loadLiveToken(win, 'http://127.0.0.1:8787', fetchImpl as unknown as typeof fetch),
      loadLiveToken(win, 'http://127.0.0.1:8787', fetchImpl as unknown as typeof fetch),
    ]);
    expect(first).toBe('granted');
    expect(second).toBe('granted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8787${LAUNCH_PATH}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'code-1' });
    expect(replaced).toEqual(['/?mode=live']);
    expect(items.get(LIVE_TOKEN_STORAGE_KEY)).toBe('granted');
  });

  it('falls back to the stored token when the code is refused', async () => {
    const { win } = fakeBrowser('?mode=live', '#launch=used', 'stored');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(loadLiveToken(win, 'http://other:1', fetchImpl as unknown as typeof fetch)).resolves.toBe('stored');
  });
});
