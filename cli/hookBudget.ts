/**
 * Time budget of `agent-viewer claude-hook`, kept in a module without dependencies so the entry point can arm
 * the hard stop before it loads anything else.
 */

/** Total time the hook may take from process start, network included. Claude Code is never kept waiting. */
export const HOOK_BUDGET_MS = 400;

let armed = false;

/** Ends the process with code 0 once the budget is spent, counted from process start. Arms once per process. */
export function armHookGuard(): void {
  if (armed) return;
  armed = true;
  const guard = setTimeout(() => process.exit(0), Math.max(50, Math.floor(HOOK_BUDGET_MS - performance.now())));
  guard.unref();
}
