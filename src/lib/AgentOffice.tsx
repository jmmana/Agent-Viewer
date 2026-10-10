import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { defaultCrewPreferences, type CrewPreferences } from '../crew/crewPreferences';
import { CrewStage } from '../crew/CrewStage';
import { CREW_ROOMS, type VisualMode } from '../crew/crewModel';
import type { CrewCameraByRoom } from '../crew/crewCamera';
import type { CrewViewerMode, CrewVisibility } from '../crew/crewEventBridge';
import { OfficeCanvas } from '../components/OfficeCanvas';
import { type CameraState, agentRoleLabel } from '../engine/canvasRenderer';
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
import { formatUsage, formatUsageBadge, type OfficeUsage } from './usage';
import type { AgentBadge } from '../engine/canvasRenderer';

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
  /** Renderer visual independiente; Caricatura sigue siendo el valor predeterminado. */
  visualMode?: VisualMode;
  /** Sala Crew controlada por el host; sin prop, se conserva por instancia. */
  crewRoomId?: string;
  onCrewRoomChange?: (roomId: string) => void;
  /** Cámaras controladas por el host; la biblioteca no escribe localStorage. */
  crewCameras?: CrewCameraByRoom;
  onCrewCamerasChange?: (cameras: CrewCameraByRoom) => void;
  /** Preferencias visuales por instancia, sin almacenamiento ni cambios al dominio. */
  crewPreferences?: CrewPreferences;
  onCrewPreferencesChange?: (preferences: CrewPreferences) => void;
  /**
   * LIVE/DEMO/REPLAY explícito (issue #155). AgentOffice nunca lo infiere de los eventos recibidos:
   * sin esta prop, Crew no muestra ninguna insignia de modo.
   */
  crewViewerMode?: CrewViewerMode;
  /** `full` (por defecto) o `minimized` para pantallas públicas/televisores (issue #155): oculta el texto de tarea y reunión en Crew, conservando solo su categoría. */
  crewVisibility?: CrewVisibility;
  /** BCP 47 locale for the built-in texts and number formats, for example `es-CO`. Defaults to `en`. */
  locale?: string;
  /** Overrides for single texts. Missing keys fall back to the built-in catalog, then to English. */
  messages?: Partial<OfficeMessages>;
  /** Host translate function (i18next and similar). Wins over `messages` when it returns a value. */
  t?: HostTranslate;
  theme?: 'dark' | 'light';
  /** Show the usage figures passed in `usage`. Off by default. */
  showUsage?: boolean;
  /**
   * Draw a compact usage badge on each agent card from `usage.byAgent`. Off by default. An agent without a
   * `byAgent` entry gets no badge. Badges follow the agent card's own visibility rule (hidden below camera
   * zoom 0.55 unless the agent is selected, hovered or speaking); the accessible agent list is always
   * available and carries the exact figures regardless of zoom.
   */
  showUsageBadges?: boolean;
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
  visualMode = 'cartoon',
  crewRoomId,
  onCrewRoomChange,
  crewCameras,
  onCrewCamerasChange,
  crewPreferences,
  onCrewPreferencesChange,
  crewViewerMode,
  crewVisibility = 'full',
  locale = 'en',
  messages,
  t,
  theme = 'dark',
  showUsage = false,
  showUsageBadges = false,
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
  const cartoonCameraMemory = useRef<CameraState | null>(null);
  const [internalCrewPreferences, setInternalCrewPreferences] = useState(defaultCrewPreferences);
  const [internalCrewRoom, setInternalCrewRoom] = useState(CREW_ROOMS[0].id);
  const [internalCrewCameras, setInternalCrewCameras] = useState<CrewCameraByRoom>({});

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
  // `showUsage || showUsageBadges` feeds the same figures into the accessible list, so the visible badge
  // and the screen-reader text always agree, whichever prop turned the figures on.
  const usageInDom = showUsage || showUsageBadges;

  const agentBadges = useMemo<ReadonlyMap<string, AgentBadge>>(() => {
    if (!showUsageBadges || !usage?.byAgent) return new Map();
    const map = new Map<string, AgentBadge>();
    for (const [agentId, figures] of Object.entries(usage.byAgent)) {
      const badge = formatUsageBadge(figures, locale, translate);
      map.set(agentId, { tokens: badge.tokens, costLabel: badge.costLabel, failed: badge.failed });
    }
    return map;
  }, [showUsageBadges, usage, locale, translate]);

  const rootClass = ['av-office', `av-theme-${theme}`, className].filter(Boolean).join(' ');

  return (
    <section className={rootClass} style={style} lang={locale} aria-label={ariaLabel ?? translate('office.label')} data-mode={mode} data-visual-mode={visualMode}>
      <div className="av-office-stage">
        {visualMode === 'crew' ? <CrewStage
          locale={locale}
          agents={snapshot.agents}
          tasks={snapshot.tasks}
          meetings={snapshot.meetings}
          viewerMode={crewViewerMode}
          visibility={crewVisibility}
          selectedRoomId={crewRoomId ?? internalCrewRoom}
          onRoomChange={roomId => {
            if (crewRoomId === undefined) setInternalCrewRoom(roomId);
            onCrewRoomChange?.(roomId);
          }}
          cameraState={crewCameras ?? internalCrewCameras}
          onCameraStateChange={cameras => {
            if (crewCameras === undefined) setInternalCrewCameras(cameras);
            onCrewCamerasChange?.(cameras);
          }}
          preferences={crewPreferences ?? internalCrewPreferences}
          onPreferencesChange={preferences => {
            if (crewPreferences === undefined) setInternalCrewPreferences(preferences);
            onCrewPreferencesChange?.(preferences);
          }}
          persistCamera={false}
          showRoomLink={false}
          idPrefix={`${listId}-crew`}
        /> : <OfficeCanvas
          cameraMemory={cartoonCameraMemory}
          agents={snapshot.agents}
          selectedAgentId={selectedId}
          onSelectAgent={handleSelect}
          activeMeetingId={snapshot.activeMeetingId}
          theme={theme}
          translate={translate}
          themeScope={false}
          agentBadges={agentBadges}
        />}

        {visualMode === 'cartoon' && snapshot.agents.length === 0 && (
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
            const agentUsage = usageInDom ? usage?.byAgent?.[agent.id] : undefined;
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
