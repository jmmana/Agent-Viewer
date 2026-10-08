import { createHash, randomUUID } from 'node:crypto';
import type { CanonicalEvent, CanonicalEventType } from '../src/integrations/canonicalTypes.ts';
import type { AgentStatus, WorkspaceZone } from '../src/types/agent.ts';
import type { ClaudeHookCommand } from './args.ts';
import { postEvents, resolveConnection } from './connection.ts';

/**
 * Claude Code hooks adapter.
 *
 * Claude Code runs `agent-viewer claude-hook` on each hook event and writes the event's JSON to stdin
 * (https://code.claude.com/docs/en/hooks). This module turns that JSON into canonical V1 events.
 *
 * Privacy: only the hook event, the tool name, the subagent type, timings and the resulting status leave the
 * machine. Tool arguments and results, prompts, file paths, the working directory, transcripts, error output
 * and notification texts are never read into an event. `--include-summaries` adds, on request, a trimmed
 * copy of Claude's final message (Stop, SubagentStop) and of the notification text.
 */

/** The subset of the hook input this adapter reads. Every other field is ignored on purpose. */
export interface ClaudeHookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  model?: string;
  source?: string;
  tool_name?: string;
  tool_use_id?: string;
  duration_ms?: number;
  is_interrupt?: boolean;
  notification_type?: string;
  message?: string;
  error?: string;
  last_assistant_message?: string;
  reason?: string;
}

export interface TranslateOptions {
  includeSummaries?: boolean;
  now?: number;
  newId?: () => string;
}

/** Hook events the installer subscribes to. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

export const RUNTIME_ID = 'claude-code';
const SUMMARY_MAX = 140;
/** Tools that start a subagent. `Task` is the name older Claude Code versions used for `Agent`. */
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);
/** Notification types that mean Claude is waiting for the person at the keyboard. */
const WAITING_NOTIFICATIONS: Record<string, { status: AgentStatus; text: string }> = {
  permission_prompt: { status: 'WAITING_APPROVAL', text: 'Waiting for your approval' },
  idle_prompt: { status: 'WAITING', text: 'Waiting for you' },
  elicitation_dialog: { status: 'WAITING', text: 'Waiting for your input' },
  elicitation_url_dialog: { status: 'WAITING', text: 'Waiting for your input' },
  agent_needs_input: { status: 'WAITING', text: 'Waiting for your input' },
};
/** Stop failure types documented by Claude Code. Anything else is reported as `unknown`. */
const STOP_FAILURE_TYPES = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown',
]);

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Collapses whitespace and cuts a text to a short, single-line summary. */
export function trimSummary(value: string, max: number = SUMMARY_MAX): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/** Tool names are identifiers (`Bash`, `mcp__github__create_issue`); anything else is cut to a safe length. */
function toolName(value: unknown): string | undefined {
  const name = text(value);
  return name ? name.slice(0, 120) : undefined;
}

function subagentWorkspace(agentType: string): { workspace: WorkspaceZone; team: string } {
  const type = agentType.toLowerCase();
  if (/(explore|research|search|investig|docs?\b|guide)/.test(type)) return { workspace: 'research_area', team: 'research' };
  if (/(review|test|qa|security|audit|verif)/.test(type)) return { workspace: 'qa_lab', team: 'quality' };
  if (/(plan|architect|lead)/.test(type)) return { workspace: 'leads_area', team: 'leadership' };
  return { workspace: 'development', team: 'engineering' };
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

/** Translates one Claude Code hook input into canonical V1 events. Returns `[]` for events it does not show. */
export function translateClaudeHook(input: ClaudeHookInput, options: TranslateOptions = {}): CanonicalEvent[] {
  const event = text(input.hook_event_name);
  const rawSession = text(input.session_id);
  if (!event || !rawSession) return [];

  const now = options.now ?? Date.now();
  const newId = options.newId ?? (() => randomUUID());
  const ids = sessionIdentity(rawSession);
  const summaries = options.includeSummaries === true;

  const subagentRawId = text(input.agent_id);
  const subagentType = text(input.agent_type);
  const actorId = subagentRawId ? ids.subagentId(subagentRawId) : ids.mainAgentId;

  const events: CanonicalEvent[] = [];
  const push = (type: CanonicalEventType, agentId: string, summary: string, payload: Record<string, unknown>, id?: string) => {
    events.push({
      schemaVersion: '1.0',
      id: id ?? `evt_cc_${newId()}`,
      type,
      timestamp: now,
      runtimeId: RUNTIME_ID,
      sessionId: ids.sessionId,
      source: `agent:${agentId}`,
      agentId,
      severity: type === 'tool.failed' || type === 'task.failed' ? 'high' : 'normal',
      summary,
      payload,
    });
  };
  const status = (agentId: string, value: AgentStatus, statusText: string) =>
    push('agent.status.changed', agentId, `${agentId} ${value}`, { status: value, statusText });

  switch (event) {
    case 'SessionStart': {
      const source = text(input.source);
      const statusText = source === 'resume' ? 'Session resumed'
        : source === 'compact' ? 'Context compacted'
          : source === 'clear' ? 'Conversation cleared'
            : 'Session started';
      const model = text(input.model);
      push('agent.registered', ids.mainAgentId, `${ids.mainAgentName} joined`, {
        id: ids.mainAgentId,
        name: ids.mainAgentName,
        roleTitle: subagentType ? `Claude Code (${subagentType.slice(0, 60)})` : 'Claude Code',
        role: 'tech_lead',
        team: 'leadership',
        provider: 'Anthropic',
        ...(model ? { model: model.slice(0, 100) } : {}),
        workspace: 'leads_area',
        status: 'AVAILABLE',
        statusText,
      });
      break;
    }

    case 'UserPromptSubmit': {
      // The prompt text is never read. The name is re-sent so a hook installed mid-session still shows a name.
      push('agent.updated', ids.mainAgentId, `${ids.mainAgentName} got a new request`, { name: ids.mainAgentName });
      status(ids.mainAgentId, 'THINKING', 'Working on a request');
      break;
    }

    case 'PreToolUse': {
      const tool = toolName(input.tool_name);
      if (!tool) return [];
      const callId = text(input.tool_use_id);
      push('tool.started', actorId, `${actorId} started ${tool}`, {
        tool,
        ...(callId ? { toolCallId: callId } : {}),
        ...(DELEGATION_TOOLS.has(tool) ? { category: 'delegation' } : {}),
      }, callId ? `evt_cc_${shortHash(`${rawSession}:${callId}:started`, 24)}` : undefined);
      if (DELEGATION_TOOLS.has(tool)) status(actorId, 'DELEGATING', 'Delegating to a subagent');
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = toolName(input.tool_name);
      if (!tool) return [];
      const callId = text(input.tool_use_id);
      const durationMs = typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms) && input.duration_ms >= 0
        ? Math.round(input.duration_ms)
        : undefined;
      const failed = event === 'PostToolUseFailure';
      push(failed ? 'tool.failed' : 'tool.completed', actorId, `${actorId} ${failed ? 'failed' : 'finished'} ${tool}`, {
        tool,
        ...(callId ? { toolCallId: callId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        // The error text can hold code, paths or command output: only its kind travels.
        ...(failed ? { error: input.is_interrupt === true ? 'interrupted' : 'failed' } : {}),
      }, callId ? `evt_cc_${shortHash(`${rawSession}:${callId}:${failed ? 'failed' : 'completed'}`, 24)}` : undefined);
      if (!failed) status(actorId, 'THINKING', 'Working');
      break;
    }

    case 'Notification': {
      const kind = text(input.notification_type);
      const waiting = kind ? WAITING_NOTIFICATIONS[kind] : undefined;
      if (!waiting) return [];
      const message = summaries ? text(input.message) : undefined;
      status(actorId, waiting.status, message ? trimSummary(message) : waiting.text);
      break;
    }

    case 'SubagentStart': {
      // Claude Code also runs internal agents (prompt suggestions, side questions) that report an empty type.
      if (!subagentRawId || !subagentType) return [];
      const subId = ids.subagentId(subagentRawId);
      const name = ids.subagentName(subagentType, subagentRawId);
      const place = subagentWorkspace(subagentType);
      push('agent.registered', subId, `${name} joined`, {
        id: subId,
        name,
        roleTitle: `Subagent: ${subagentType.slice(0, 60)}`,
        role: 'custom',
        team: place.team,
        provider: 'Anthropic',
        managerId: ids.mainAgentId,
        workspace: place.workspace,
        status: 'THINKING',
        statusText: 'Starting',
      });
      push('agent.message.sent', ids.mainAgentId, `${ids.mainAgentName} hands off to ${name}`, {
        text: `Handing off to ${name}`,
        targetAgentId: subId,
        targetAgentName: name,
        kind: 'statement',
      });
      status(subId, 'THINKING', 'Working');
      break;
    }

    case 'SubagentStop': {
      if (!subagentRawId || !subagentType) return [];
      const subId = ids.subagentId(subagentRawId);
      const name = ids.subagentName(subagentType, subagentRawId);
      const finalMessage = summaries ? text(input.last_assistant_message) : undefined;
      push('agent.message.sent', subId, `${name} reports back`, {
        text: finalMessage ? trimSummary(finalMessage) : 'Done, handing back',
        targetAgentId: ids.mainAgentId,
        targetAgentName: ids.mainAgentName,
        kind: finalMessage ? 'summary' : 'answer',
      });
      status(subId, 'DONE', 'Finished');
      status(ids.mainAgentId, 'THINKING', 'Reviewing subagent results');
      break;
    }

    case 'Stop': {
      const finalMessage = summaries ? text(input.last_assistant_message) : undefined;
      if (finalMessage) {
        push('agent.message.sent', ids.mainAgentId, `${ids.mainAgentName} answered`, {
          text: trimSummary(finalMessage),
          kind: 'summary',
        });
      }
      status(ids.mainAgentId, 'DONE', 'Turn finished');
      break;
    }

    case 'StopFailure': {
      const kind = text(input.error);
      const safeKind = kind && STOP_FAILURE_TYPES.has(kind) ? kind : 'unknown';
      status(ids.mainAgentId, 'ERROR', `Stopped by an API error (${safeKind})`);
      break;
    }

    case 'SessionEnd': {
      status(ids.mainAgentId, 'OFFLINE', 'Session ended');
      break;
    }

    default:
      return [];
  }

  return events;
}

/** Total time the hook may take from process start, network included. Claude Code is never kept waiting. */
export const HOOK_BUDGET_MS = 400;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function debug(message: string): void {
  if (process.env.AGENT_VIEWER_DEBUG) process.stderr.write(`[agent-viewer claude-hook] ${message}\n`);
}

function readStdin(limitBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        process.stdin.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(undefined));
  });
}

/**
 * Runs the hook: reads stdin, sends the events, and always exits 0 within the budget. It writes nothing to
 * stdout, because Claude Code adds a hook's stdout to the conversation on some events.
 */
export async function runClaudeHook(command: ClaudeHookCommand): Promise<number> {
  const elapsed = () => performance.now();
  // Hard stop: whatever happens (slow server, open stdin), the process ends inside the budget.
  const guard = setTimeout(() => process.exit(0), Math.max(50, Math.floor(HOOK_BUDGET_MS - elapsed())));
  guard.unref();

  if (process.stdin.isTTY) {
    process.stderr.write('agent-viewer claude-hook reads a Claude Code hook event from stdin. See docs/claude-code.md.\n');
    return 0;
  }

  try {
    const raw = await readStdin(MAX_INPUT_BYTES);
    if (!raw) return 0;
    const input = JSON.parse(raw) as ClaudeHookInput;
    if (!input || typeof input !== 'object') return 0;
    const events = translateClaudeHook(input, { includeSummaries: command.includeSummaries });
    if (events.length === 0) return 0;

    const remaining = Math.floor(HOOK_BUDGET_MS - 30 - elapsed());
    if (remaining <= 0) return 0;
    const connection = resolveConnection(command);
    const result = await postEvents(connection, events, { signal: AbortSignal.timeout(remaining) });
    if (!result.ok) debug(`server answered ${result.status}`);
  } catch (error) {
    debug(error instanceof Error ? error.message : String(error));
  }
  return 0;
}
