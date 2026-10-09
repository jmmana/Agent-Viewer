import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// In its own process (node:test runs each file apart): startViewer sets the server variables and imports it.
const home = mkdtempSync(path.join(os.tmpdir(), 'av-launch-'));
process.env.AGENT_VIEWER_HOME = home;
process.env.AGENT_VIEWER_API_TOKEN = '   ';
delete process.env.AGENT_VIEWER_API_KEY;
const { startViewer } = await import('../cli/start.ts');

test('CLI start: the office trades a launch code for the token once, and a blank variable still gets a token', async () => {
  const viewer = await startViewer({ command: 'start', port: 0, host: '127.0.0.1', demo: false, open: false });
  try {
    assert.match(viewer.token, /^av_/, 'a blank AGENT_VIEWER_API_TOKEN is treated as unset');
    assert.equal(JSON.parse(readFileSync(path.join(home, 'session.json'), 'utf8')).token, viewer.token);
    assert.equal((await fetch(`${viewer.url}/api/v1/snapshot`)).status, 401);

    const code = viewer.issueLaunchCode();
    const redeem = () => fetch(`${viewer.url}/api/cli/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const first = await redeem();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await first.json(), { token: viewer.token });
    assert.equal((await redeem()).status, 404, 'a launch code works once');

    // With the token in the Authorization header, the stream opens without the token in the URL.
    const stream = await fetch(`${viewer.url}/api/v1/events/stream`, { headers: { Authorization: `Bearer ${viewer.token}` } });
    assert.equal(stream.status, 200);
    await stream.body.cancel();
  } finally {
    await viewer.close();
    rmSync(home, { recursive: true, force: true });
  }
});
