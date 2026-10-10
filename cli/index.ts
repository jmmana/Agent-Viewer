/**
 * `agent-viewer` command line. Each command module is loaded on demand, so `claude-hook` and `send` start fast
 * and never load the server, express or zod.
 */
import { armHookGuard } from './hookBudget.ts';
import type { CliCommand } from './args.ts';

// The hook's hard stop goes first. Static imports are evaluated before this line, so the only one is the
// dependency-free budget module; the parser and everything else load after the guard is armed.
if (process.argv[2] === 'claude-hook') armHookGuard();

const { CliUsageError, parseCliArgs, USAGE } = await import('./args.ts');
const { packageInfo } = await import('./packageInfo.ts');

async function run(command: CliCommand): Promise<number> {
  switch (command.command) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'version':
      console.log(packageInfo().version);
      return 0;
    case 'send': {
      const { runSend } = await import('./send.ts');
      return runSend(command);
    }
    case 'claude-hook': {
      const { runClaudeHook } = await import('./claudeHook.ts');
      return runClaudeHook(command);
    }
    case 'install':
    case 'uninstall': {
      const { runInstall } = await import('./claudeInstall.ts');
      return runInstall(command);
    }
    case 'otel-headers': {
      const { runOtelHeaders } = await import('./otelHeaders.ts');
      return runOtelHeaders(command);
    }
    case 'start': {
      const { runStart } = await import('./start.ts');
      return runStart(command);
    }
  }
}

async function main(argv: string[]): Promise<void> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (argv[0] === 'claude-hook') {
      // A hook must never fail Claude Code, not even on a bad flag.
      process.exit(0);
    }
    if (error instanceof CliUsageError) {
      console.error(`agent-viewer: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const code = await run(command);
  // The hook always exits 0. After start stops, nothing is left to wait for (open sockets were closed).
  if (command.command === 'claude-hook') process.exit(0);
  if (command.command === 'start') process.exit(code);
  process.exitCode = code;
}

main(process.argv.slice(2)).catch((error) => {
  if (process.argv[2] === 'claude-hook') process.exit(0);
  console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
