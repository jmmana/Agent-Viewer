import React from 'react';
import { X } from 'lucide-react';
import type { OfficeTranslate } from '../content/officeMessages';
import { formatCost, formatCostSource, formatTokens } from './usage';
import type { AgentCallDetail, AgentCallStatus } from './callDetails';

/** Longer values are cut here, in the text and in the `title` attribute, so neither ever carries more. */
const MAX_TEXT_LENGTH = 128;

const KNOWN_STATUSES: readonly AgentCallStatus[] = ['ok', 'failed', 'rate_limited'];

function isKnownStatus(value: unknown): value is AgentCallStatus {
  return KNOWN_STATUSES.includes(value as AgentCallStatus);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Plain text only, never HTML: the value comes back as a text node regardless of what it contains. An
 * empty, whitespace-only or non-string value is treated as "not sent" (`null`). A value longer than
 * `MAX_TEXT_LENGTH` Unicode code points is cut to one less, plus an ellipsis.
 */
function safeText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_TEXT_LENGTH) return value;
  return `${codePoints.slice(0, MAX_TEXT_LENGTH - 1).join('')}…`;
}

function statusLabel(status: AgentCallDetail['status'], translate: OfficeTranslate): string {
  return isKnownStatus(status) ? translate(`calls.status.${status}`) : translate('usage.unknown');
}

function latencyLabel(value: AgentCallDetail['latencyMs'], locale: string | undefined, translate: OfficeTranslate): string {
  if (!isFiniteNumber(value)) return translate('usage.unknown');
  return translate('calls.latencyValue', { value: new Intl.NumberFormat(locale).format(value) });
}

interface CallDetailRowProps {
  label: string;
  value: string;
  className?: string;
  title?: string;
}

function CallDetailRow({ label, value, className, title }: CallDetailRowProps): React.JSX.Element {
  return (
    <div className="av-call-row">
      <dt>{label}</dt>
      <dd className={className} title={title}>{value}</dd>
    </div>
  );
}

interface CallItemProps {
  call: AgentCallDetail;
  locale: string | undefined;
  translate: OfficeTranslate;
}

/**
 * One call's rows. Every value is picked from `call` by its exact, whitelisted field: the object is never
 * spread and its keys are never iterated, so an extra key (for example `prompt`, added by a JavaScript host
 * that bypasses the types) is never rendered, by construction rather than by filtering.
 */
function CallItem({ call, locale, translate }: CallItemProps): React.JSX.Element {
  const tokens = call.tokens;
  const requestId = safeText(call.requestId);
  return (
    <li className="av-call-item">
      <dl>
        <CallDetailRow label={translate('calls.provider')} value={safeText(call.provider) ?? translate('usage.unknown')} />
        <CallDetailRow label={translate('calls.model')} value={safeText(call.model) ?? translate('usage.unknown')} />
        <CallDetailRow label={translate('calls.status')} value={statusLabel(call.status, translate)} />
        <CallDetailRow label={translate('calls.latency')} value={latencyLabel(call.latencyMs, locale, translate)} />
        <CallDetailRow
          label={translate('calls.requestId')}
          value={requestId ?? translate('usage.unknown')}
          className="av-call-request-id"
          title={requestId ?? undefined}
        />
        <CallDetailRow label={translate('usage.inputTokens')} value={formatTokens(tokens?.input, locale, translate)} />
        <CallDetailRow label={translate('usage.outputTokens')} value={formatTokens(tokens?.output, locale, translate)} />
        {tokens?.cacheRead !== undefined && (
          <CallDetailRow label={translate('usage.cacheReadTokens')} value={formatTokens(tokens.cacheRead, locale, translate)} />
        )}
        {tokens?.cacheWrite !== undefined && (
          <CallDetailRow label={translate('usage.cacheWriteTokens')} value={formatTokens(tokens.cacheWrite, locale, translate)} />
        )}
        {tokens?.reasoning !== undefined && (
          <CallDetailRow label={translate('usage.reasoningTokens')} value={formatTokens(tokens.reasoning, locale, translate)} />
        )}
        <CallDetailRow label={translate('usage.costSource')} value={formatCostSource(call.costSource, translate)} />
        <CallDetailRow label={translate('usage.cost')} value={formatCost(call.cost, call.currency, locale, translate)} />
      </dl>
    </li>
  );
}

export interface CallDetailsPanelProps {
  agentName: string;
  calls: readonly AgentCallDetail[];
  locale: string | undefined;
  translate: OfficeTranslate;
  onClose: () => void;
}

/**
 * Read-only panel with the metadata of the selected agent's calls. Never fetches, never aggregates: it
 * shows exactly the rows the host sent, in the host's order, and nothing the host did not send.
 */
export function CallDetailsPanel({ agentName, calls, locale, translate, onClose }: CallDetailsPanelProps): React.JSX.Element {
  const label = translate('calls.title', { name: agentName });
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <section className="av-call-details" aria-label={label} onKeyDown={handleKeyDown}>
      <div className="av-call-details-header">
        <span>{label}</span>
        <button type="button" className="av-call-details-close" aria-label={translate('calls.close')} onClick={onClose}>
          <X className="av-icon" aria-hidden="true" />
        </button>
      </div>
      {calls.length === 0 ? (
        <p className="av-call-details-empty">{translate('calls.empty')}</p>
      ) : (
        <ul className="av-call-details-list">
          {calls.map((call, index) => (
            // The host's `id` is not unique by contract (see `AgentCallDetail.id`), so the index breaks ties.
            <CallItem key={`${call.id}:${index}`} call={call} locale={locale} translate={translate} />
          ))}
        </ul>
      )}
    </section>
  );
}
