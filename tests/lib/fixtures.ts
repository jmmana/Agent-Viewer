/**
 * Synthetic events and helpers shared by the library tests. Every name, run and figure here is invented.
 */
import {
  OFFICE_MESSAGES,
  type CanonicalEvent,
  type CanonicalEventType,
  type OfficeMessageKey,
} from '../../src/lib/index';

/** Start of the synthetic run: 15 January 2026, 14:00 UTC. */
export const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

let sequence = 0;

export interface EventOptions {
  id?: string;
  /** Event time in milliseconds. Defaults to `T0`. */
  at?: number;
  summary?: string;
}

export function makeEvent(
  type: CanonicalEventType,
  agentId: string,
  payload: Record<string, unknown> = {},
  options: EventOptions = {},
): CanonicalEvent {
  sequence += 1;
  return {
    schemaVersion: '1.0',
    id: options.id ?? `evt-${sequence}-${type}-${agentId}`,
    type,
    timestamp: options.at ?? T0,
    source: `agent:${agentId}`,
    agentId,
    severity: 'normal',
    summary: options.summary ?? `${type} (${agentId})`,
    payload,
  };
}

export function registered(
  agentId: string,
  name: string,
  profile: { roleTitle?: string; workspace?: string; avatarColor?: string } = {},
  options: EventOptions = {},
): CanonicalEvent {
  return makeEvent('agent.registered', agentId, { name, ...profile }, options);
}

export function statusChanged(agentId: string, status: string, options: EventOptions = {}): CanonicalEvent {
  return makeEvent('agent.status.changed', agentId, { status }, options);
}

export function meetingRequested(
  initiatorId: string,
  meetingId: string,
  participantIds: string[],
  options: EventOptions = {},
): CanonicalEvent {
  return makeEvent('meeting.requested', initiatorId, { meetingId, participantIds, title: 'Release review' }, options);
}

export function meetingMessage(
  agentId: string,
  meetingId: string,
  text: string,
  type?: string,
  options: EventOptions = {},
): CanonicalEvent {
  return makeEvent('meeting.message', agentId, { meetingId, text, ...(type ? { type } : {}) }, options);
}

export function messageSent(
  agentId: string,
  text: string,
  extra: Record<string, unknown> = {},
  options: EventOptions = {},
): CanonicalEvent {
  return makeEvent('agent.message.sent', agentId, { text, ...extra }, options);
}

export function llmUsage(agentId: string, payload: Record<string, unknown>, options: EventOptions = {}): CanonicalEvent {
  return makeEvent('llm.usage', agentId, payload, options);
}

export function llmFailed(agentId: string, payload: Record<string, unknown>, options: EventOptions = {}): CanonicalEvent {
  return makeEvent('llm.failed', agentId, payload, options);
}

/* ------------------------------------------------------------------------------------------------ */
/* Language checks                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CatalogEntry {
  key: OfficeMessageKey;
  value: string;
  pattern: RegExp;
}

/**
 * English catalog values that differ from their Spanish translation. Values that are the same in both
 * languages ("Tokens", "QA", "Error", "{percent}%") are left out because seeing them proves nothing.
 *
 * Each value becomes a whole-word pattern (placeholders match any text), so the English "Agent" is not
 * found inside the Spanish "Agentes".
 */
export function englishOnlyEntries(): CatalogEntry[] {
  const en = OFFICE_MESSAGES.en;
  const es = OFFICE_MESSAGES.es;
  return (Object.keys(en) as OfficeMessageKey[])
    .filter((key) => en[key] !== es[key])
    .map((key) => {
      const body = en[key].split(/\{\w+\}/).map(escapeRegExp).join('.+?');
      return { key, value: en[key], pattern: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u') };
    });
}

/** Describes every text that shows an English-only catalog value. Empty when the texts are clean. */
export function findEnglishLeaks(texts: readonly string[]): string[] {
  const entries = englishOnlyEntries();
  const leaks: string[] = [];
  for (const text of texts) {
    for (const entry of entries) {
      if (entry.pattern.test(text)) leaks.push(`"${text}" shows the English ${entry.key} = "${entry.value}"`);
    }
  }
  return leaks;
}

/**
 * Every text a person or a screen reader can get from the page: each text node on its own, the whole
 * `textContent`, and the `aria-label`, `aria-valuetext` and `title` attributes.
 */
export function collectVisibleTexts(root: HTMLElement = document.body): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue?.trim();
    if (value) texts.push(value);
  }
  if (root.textContent?.trim()) texts.push(root.textContent);
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of ['aria-label', 'aria-valuetext', 'title']) {
      const value = element.getAttribute(attribute);
      if (value) texts.push(value);
    }
  }
  return texts;
}
