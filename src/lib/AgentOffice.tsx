import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { OfficeCanvas } from '../components/OfficeCanvas';
import { agentRoleLabel } from '../engine/canvasRenderer';
import {
  createOfficeTranslator,
  type HostTranslate,
  type OfficeMessages,
} from '../content/officeMessages';
import { DEFAULT_BUBBLE_MS } from '../integrations/eventIngestion';
import {
  OfficeStore,
  type AgentProfile,
  type OfficeEventInput,
  type OfficeMode,
} from './officeStore';
import { formatUsage, type OfficeUsage } from './usage';

/** How often the office checks whether walks finished and meetings can start. */
const TICK_MS = 250;
const NO_EVENTS: readonly OfficeEventInput[] = [];

export interface AgentOfficeProps {
  /**
   * The source of truth. The office is rebuilt from these events: append to the list for live activity, or
   * pass a growing or shrinking slice of a recorded run for replay.
   */
  events?: readonly OfficeEventInput[];
  /** Agents known before their first event: name, role title, team, room and color. */
  agents?: readonly AgentProfile[];
  /** `professional` (default) shows only what the events say. `showcase` adds simulated office life. */
  mode?: OfficeMode;
  /** BCP 47 locale for the built-in texts and number formats, for example `es-CO`. Defaults to `en`. */
  locale?: string;
  /** Overrides for single texts. Missing keys fall back to the built-in catalog, then to English. */
  messages?: Partial<OfficeMessages>;
  /** Host translate function (i18next and similar). Wins over `messages` when it returns a value. */
  t?: HostTranslate;
  theme?: 'dark' | 'light';
  /** Show the usage figures passed in `usage`. Off by default. */
  showUsage?: boolean;
  /** Usage figures computed by the host. The office never computes them. */
  usage?: OfficeUsage;
  /** Controlled selection. Leave undefined to let the office keep its own. */
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string | null) => void;
  /** How long a speech bubble stays on screen, in milliseconds. */
  bubbleDurationMs?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible name of the office region. Defaults to the `office.label` text. */
  ariaLabel?: string;
}

export const AgentOffice: React.FC<AgentOfficeProps> = ({
  events = NO_EVENTS,
  agents: profiles,
  mode = 'professional',
  locale = 'en',
  messages,
  t,
  theme = 'dark',
  showUsage = false,
  usage,
  selectedAgentId,
  onSelectAgent,
  bubbleDurationMs = DEFAULT_BUBBLE_MS,
  className,
  style,
  ariaLabel,
}) => {
  const storeRef = useRef<OfficeStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new OfficeStore({ mode, bubbleMs: bubbleDurationMs, locale });
  }
  const store = storeRef.current;
  const [version, setVersion] = useState(0);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const listId = useId();

  const translate = useMemo(() => createOfficeTranslator({ locale, messages, t }), [locale, messages, t]);

  // Deriving the office during render keeps the first paint in sync with the events. `sync` is idempotent,
  // so a second render with the same events is a no-op.
  const snapshot = useMemo(() => {
    store.sync(events, profiles, Date.now(), { mode, bubbleMs: bubbleDurationMs, locale });
    return store.snapshot();
    // `version` is listed on purpose: it re-reads the store after a tick moved the office forward.
  }, [store, events, profiles, mode, bubbleDurationMs, locale, version]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (store.tick(Date.now())) setVersion((value) => value + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [store]);

  const selectedId = selectedAgentId !== undefined ? selectedAgentId : internalSelectedId;
  const handleSelect = (agentId: string | null) => {
    if (selectedAgentId === undefined) setInternalSelectedId(agentId);
    onSelectAgent?.(agentId);
  };

  const usageItems = showUsage && usage?.total ? formatUsage(usage.total, locale, translate) : [];

  const rootClass = ['av-office', `av-theme-${theme}`, className].filter(Boolean).join(' ');

  return (
    <section className={rootClass} style={style} aria-label={ariaLabel ?? translate('office.label')} data-mode={mode}>
      <div className="av-office-stage">
        <OfficeCanvas
          agents={snapshot.agents}
          selectedAgentId={selectedId}
          onSelectAgent={handleSelect}
          activeMeetingId={snapshot.activeMeetingId}
          theme={theme}
          translate={translate}
          themeScope={false}
        />

        {snapshot.agents.length === 0 && (
          <div className="av-office-empty">
            <span>{translate('office.empty')}</span>
          </div>
        )}

        {usageItems.length > 0 && (
          <dl className="av-usage" aria-label={translate('usage.title')}>
            {usageItems.map((item) => (
              <div key={item.label} className="av-usage-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/*
        Text alternative of the canvas and keyboard access: hidden until it receives focus (Tab), then shown
        as a panel. Choosing an agent selects it and moves the camera to it, like a click on the canvas.
      */}
      <div className="av-agent-list">
        <p id={listId} className="av-agent-list-title">{translate('office.agentsHeading')}</p>
        <ul aria-labelledby={listId} aria-live="polite">
          {snapshot.agents.map((agent) => {
            const role = agentRoleLabel(agent, translate);
            const status = translate(`status.${agent.status}`);
            const line = role
              ? translate('office.agentLine', { name: agent.name, role, status })
              : translate('office.agentLineNoRole', { name: agent.name, status });
            const agentUsage = showUsage ? usage?.byAgent?.[agent.id] : undefined;
            const usageText = agentUsage
              ? formatUsage(agentUsage, locale, translate).map((item) => `${item.label}: ${item.value}`).join(', ')
              : '';
            const selected = selectedId === agent.id;
            return (
              <li key={agent.id} data-agent-id={agent.id}>
                <button
                  type="button"
                  className="av-agent-list-item"
                  aria-pressed={selected}
                  onClick={() => handleSelect(selected ? null : agent.id)}
                >
                  {usageText ? `${line}. ${usageText}` : line}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
