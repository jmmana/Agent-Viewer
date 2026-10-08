// Starts the ingestion server and the office together, with the office in live mode so the events you send
// to the server show up right away. Works on macOS, Linux and Windows (no shell features needed).
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, VITE_AGENT_VIEWER_MODE: process.env.VITE_AGENT_VIEWER_MODE ?? 'live' };
const children = [
  spawn(npm, ['run', 'server'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
];

const stop = (code = 0) => {
  for (const child of children) if (!child.killed) child.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
