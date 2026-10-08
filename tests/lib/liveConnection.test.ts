import { describe, expect, it } from 'vitest';
import { resolveLiveConnection } from '../../src/integrations/liveConnection';

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
