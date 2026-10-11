import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Agent, AgentStatus, PricingConfig, ViewerEvent } from './types/agent';
import { DEFAULT_PRICING, INITIAL_AGENTS } from './engine/officeModel';
import {
  createDemoSteps,
  createInitialSimulationState,
  createLiveSimulationState,
  SimulationState,
  triggerCustomTaskSimulation,
} from './engine/simulationEngine';
import { localizeDemoText } from './content/demoScript';
import { TopBar } from './components/TopBar';
import { OpenApiBanner } from './components/OpenApiBanner';
import { ResyncNotice } from './components/ResyncNotice';
import type { CameraState, AgentBadge } from './engine/canvasRenderer';
import { OfficeCanvas } from './components/OfficeCanvas';
import { formatCost, formatTokens, formatUsageBadge } from './lib/usage';
import { rollupToOfficeUsage } from './integrations/ledgerToUsage';
import type { RollupResponse } from './integrations/ledgerClient';
import { useLedgerAgentUsage } from './components/usage/useLedgerAgentUsage';
import { loadUsageWindow, saveUsageWindow, type UsageWindowOption } from './integrations/usageWindow';
import {
  loadMaskSecrets,
  saveMaskSecrets,
  loadShowUsageBadges,
  saveShowUsageBadges,
} from './integrations/displayPreferences';
import { CrewStage } from './crew/CrewStage';
import type { VisualMode } from './crew/crewModel';
import { readCrewPreferences, saveCrewPreferences } from './crew/crewPreferences';
import { readCrewEntry, saveCrewNavigation, replaceCrewLink } from './crew/crewNavigation';
import { AgentInspector } from './components/AgentInspector';
import { ActivityTimeline } from './components/ActivityTimeline';
import { TaskBoard } from './components/TaskBoard';
import { MeetingRoomModal } from './components/MeetingRoomModal';
import { SettingsModal } from './components/SettingsModal';
import { NewTaskModal } from './components/NewTaskModal';
import { LiveTimelineSidebar } from './components/LiveTimelineSidebar';
import { OverflowFloorView } from './components/OverflowFloorView';
import { ModelOpsModal } from './components/ModelOpsModal';
import { AgentDetailModal } from './components/AgentDetailModal';
import { recordSimulatedCall, SimulatedCall } from './engine/modelOps';
import type { LedgerConnection } from './components/modelOps/useModelOpsLedger';
import { DoorOpen } from 'lucide-react';
import { applyDocumentLocale, detectLocale, Locale, persistLocale, t, type TranslationKey } from './i18n';
import { createOfficeTranslator } from './content/officeMessages';
import { advanceLivingOffice, applyAmbientLife } from './engine/livingOfficeEngine';
import { applyExternalEvent } from './integrations/eventIngestion';
import { connectEventStream } from './integrations/realtimeClient';
import { rebuildFromSnapshot, type LiveSnapshot } from './integrations/snapshotRebuild';
import { loadLiveHistory, parseHistoryLimit } from './integrations/historyLoader';
import { loadLiveToken, resolveLiveConnection, takeLiveCredentials } from './integrations/liveConnection';
import { useServerAuthState } from './integrations/serverHealth';
import { clearSession, loadSession, saveSession, createThrottledSessionWriter } from './engine/sessionStorage';
import { parseEventLog } from './integrations/eventLogParser';
import { getDropErrorKey } from './integrations/dropErrorKey';
import { cloneUsageTally } from './integrations/usageTally';
import { Upload, AlertCircle, X } from 'lucide-react';

/**
 * Bounds how many events the live portal loads on open, beyond the snapshot's own 100 (issue #72). Only the
 * activity timeline goes this deep; figures always come from the snapshot's own totals.
 */
const LIVE_HISTORY_LIMIT = parseHistoryLimit(import.meta.env.VITE_AGENT_VIEWER_HISTORY_LIMIT as string | undefined);

export default function App() {
  const isLiveMode = typeof window !== 'undefined' && (
    import.meta.env.VITE_AGENT_VIEWER_MODE === 'live' ||
    new URLSearchParams(window.location.search).get('mode') === 'live'
  );
  const apiBase = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return resolveLiveConnection(
      window.location,
      import.meta.env.VITE_AGENT_VIEWER_API_URL as string | undefined,
      isLiveMode,
    ).apiBase;
  }, [isLiveMode]);
  // The /health poll never runs outside live mode, so demo and simulation never make a network request.
  const serverAuth = useServerAuthState(isLiveMode ? apiBase : undefined);

  const [isLiveConnected, setIsLiveConnected] = useState(false);
  // Rótulo explícito LIVE/DEMO/REPLAY para Crew (issue #155). No se infiere de los datos: arranca según
  // `isLiveMode` y pasa a 'replay' solo cuando el usuario suelta un archivo de eventos para reproducirlo.
  const [lastSource, setLastSource] = useState<'live' | 'demo' | 'replay'>(() => (isLiveMode ? 'live' : 'demo'));
  const crewViewerMode = lastSource === 'live' ? 'LIVE' as const : lastSource === 'replay' ? 'REPLAY' as const : 'DEMO' as const;
  // Load phase of the live portal (issue #72): the top bar badge is driven by this, not by the arrival of an
  // event, so a quiet server still shows a loading state instead of looking stuck on "CONNECTING".
  const [livePhase, setLivePhase] = useState<'loading' | 'subscribing' | 'live' | 'reconnecting' | 'error'>('loading');
  // Bumped to retry the history load after it failed (issue #72); only read by the live effect's dependency list.
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  // Shown after the stream resyncs (issue #54): the server could not replay everything missed, so the office was
  // reloaded from a fresh snapshot. `missed` is `null` when the server itself does not know the count.
  const [resyncNotice, setResyncNotice] = useState<{ missed: number | null } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // Master Simulation State
  const [simState, setSimState] = useState<SimulationState>(() => {
    const isLive = typeof window !== 'undefined' && (
      import.meta.env.VITE_AGENT_VIEWER_MODE === 'live' ||
      new URLSearchParams(window.location.search).get('mode') === 'live'
    );
    if (isLive) {
      return createLiveSimulationState();
    }
    const restored = typeof window !== 'undefined' ? loadSession(window.localStorage) : null;
    return restored ?? createInitialSimulationState(INITIAL_AGENTS, detectLocale());
  });

  // Active navigation tab
  const [currentTab, setCurrentTab] = useState<'office' | 'tasks' | 'meetings' | 'timeline'>('office');
  // UI-only mode: does not alter event telemetry, simulation, replay or the legacy renderer.
  const cartoonCameraMemory = useRef<CameraState | null>(null);
  const [crewPreferences, setCrewPreferences] = useState(readCrewPreferences);
  useEffect(() => saveCrewPreferences(crewPreferences), [crewPreferences]);
  const [crewEntry] = useState(readCrewEntry);
  const [crewNavigation, setCrewNavigation] = useState(crewEntry.navigation);
  const [crewMissingRoom, setCrewMissingRoom] = useState(crewEntry.missingRoom);
  const visualMode = crewNavigation.selectedMode;
  const setVisualMode = (selectedMode: VisualMode) => setCrewNavigation(previous => ({ ...previous, selectedMode }));
  const setCrewRoom = (selectedRoomId: string) => {
    setCrewMissingRoom(false);
    setCrewNavigation(previous => ({ ...previous, selectedRoomId }));
  };
  useEffect(() => { saveCrewNavigation(crewNavigation); replaceCrewLink(crewNavigation); }, [crewNavigation]);

  // Collapsible vertical live timeline sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 1024);

  // Selected agent for Inspector
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Model Ops Telemetry Modal state
  const [isModelOpsOpen, setIsModelOpsOpen] = useState(false);
  const [modelOpsInitialProvider, setModelOpsInitialProvider] = useState<string | null>(null);
  // What-if calls from the Model Ops simulator. Kept outside simState: never persisted, exported or counted.
  const [simulatedCalls, setSimulatedCalls] = useState<SimulatedCall[]>([]);
  // Token for Model Ops' usage-ledger client (issue #79): resolved asynchronously (URL fragment, launch code or
  // `sessionStorage`, see `liveConnection.ts`). `resolved` stays false until that finishes, so the modal shows a
  // loading state instead of ever reading a real 401 as "unauthorized" too early.
  const [liveTokenState, setLiveTokenState] = useState<{ resolved: boolean; token?: string }>({ resolved: false });
  // Shared by Model Ops, the office spend badges/top-bar total (issue #78) and the Meetings panel / tool spend
  // tooltips (issue #81): one `LedgerConnection` so every consumer reads the same base URL and token and agrees
  // on "unavailable" vs "unauthorized".
  const ledgerConnection = useMemo<LedgerConnection | null>(
    () => (apiBase ? { baseUrl: apiBase, token: liveTokenState.token, tokenResolved: liveTokenState.resolved } : null),
    [apiBase, liveTokenState.token, liveTokenState.resolved],
  );

  // Usage window for the office spend badges and top-bar total (issue #78), persisted across reloads.
  const [usageWindow, setUsageWindowState] = useState<UsageWindowOption>(() =>
    loadUsageWindow(typeof window !== 'undefined' ? window.localStorage : undefined)
  );
  const handleChangeUsageWindow = (option: UsageWindowOption) => {
    setUsageWindowState(option);
    saveUsageWindow(typeof window !== 'undefined' ? window.localStorage : undefined, option);
  };
  const ledgerUsage = useLedgerAgentUsage({ ledger: ledgerConnection, window: usageWindow, events: simState.events });
  // Kept across a loading/error refetch so the badges and top-bar total never flash back to the (misleading)
  // locally summed figures while the ledger is merely re-fetching; cleared only when the server tells us the
  // ledger truly is not available (`unavailable`/`unauthorized`), when the previous figures would be wrong to
  // keep showing.
  const [lastReadyRollup, setLastReadyRollup] = useState<RollupResponse | null>(null);
  useEffect(() => {
    if (ledgerUsage.query.status === 'ready') setLastReadyRollup(ledgerUsage.query.data);
    else if (ledgerUsage.query.status === 'unavailable' || ledgerUsage.query.status === 'unauthorized') setLastReadyRollup(null);
  }, [ledgerUsage.query]);
  const officeLedgerUsage = lastReadyRollup ? rollupToOfficeUsage(lastReadyRollup) : null;
  // A refetch failed but earlier figures are still shown (issue #78): every usage surface marks itself "stale"
  // instead of looking like a confirmed-fresh reading.
  const isUsageStale = ledgerUsage.query.status === 'error' && lastReadyRollup !== null;

  // Display preferences (issue #78), persisted in `localStorage`: display-only, never sent to the server and
  // never affecting what is fetched.
  const [maskSecrets, setMaskSecretsState] = useState(() =>
    loadMaskSecrets(typeof window !== 'undefined' ? window.localStorage : undefined)
  );
  const handleChangeMaskSecrets = (value: boolean) => {
    setMaskSecretsState(value);
    saveMaskSecrets(typeof window !== 'undefined' ? window.localStorage : undefined, value);
  };
  const [showUsageBadges, setShowUsageBadgesState] = useState(() =>
    loadShowUsageBadges(typeof window !== 'undefined' ? window.localStorage : undefined)
  );
  const handleChangeShowUsageBadges = (value: boolean) => {
    setShowUsageBadgesState(value);
    saveShowUsageBadges(typeof window !== 'undefined' ? window.localStorage : undefined, value);
  };

  // Agent Detail Modal state (triggered on double click)
  const [detailModalAgentId, setDetailModalAgentId] = useState<string | null>(null);
  // Which tab the modal should land on next (issue #78's "View calls" from the inspector); reset once consumed
  // so re-opening the same agent from elsewhere does not keep jumping back to metrics.
  const [detailModalInitialTab, setDetailModalInitialTab] = useState<
    'overview' | 'tasks' | 'metrics' | 'logs' | 'console' | null
  >(null);
  const openDetailModal = (agentId: string, tab?: 'overview' | 'tasks' | 'metrics' | 'logs' | 'console') => {
    setDetailModalAgentId(agentId);
    setDetailModalInitialTab(tab ?? null);
  };

  // Demo Playback Engine state
  const [isPlayingDemo, setIsPlayingDemo] = useState(false);
  const [demoStepIndex, setDemoStepIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [pricing, setPricing] = useState<PricingConfig[]>(DEFAULT_PRICING);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const officeTranslate = useMemo(() => createOfficeTranslator({ locale }), [locale]);
  // The demo script is written in the current language; steps already played keep their texts, and the views
  // show the built-in demo texts in the current language through `localizeDemoText`.
  const demoSteps = useMemo(() => createDemoSteps(locale), [locale]);
  const statusLabel = (status: AgentStatus) => t(locale, `status.${status}` as TranslationKey);
  const agentName = (agents: Agent[], agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [ambientSocialEnabled, setAmbientSocialEnabled] = useState(true);
  const [politicsChatterEnabled, setPoliticsChatterEnabled] = useState(false);
  const [currentFloor, setCurrentFloor] = useState<1 | 2>(1);

  useEffect(() => {
    persistLocale(locale);
    applyDocumentLocale(locale);
  }, [locale]);

  const sessionWriterRef = useRef<ReturnType<typeof createThrottledSessionWriter> | null>(null);
  if (!sessionWriterRef.current && typeof window !== 'undefined') {
    sessionWriterRef.current = createThrottledSessionWriter(window.localStorage, 1000);
  }

  useEffect(() => {
    if (sessionWriterRef.current && !isLiveMode) {
      sessionWriterRef.current.schedule(simState);
    }
  }, [simState, isLiveMode]);

  // Keep a ref to current simulation state to avoid stale closure during step execution
  const simStateRef = useRef(simState);
  simStateRef.current = simState;

  // Execute a specific demo step
  const executeStep = (stepIdx: number) => {
    if (stepIdx < 0 || stepIdx >= demoSteps.length) return;
    const step = demoSteps[stepIdx];

    setSimState((prevState) => {
      // Deep clone to update reactively
      const nextState: SimulationState = {
        ...prevState,
        agents: prevState.agents.map((a) => ({ ...a, usage: a.usage ? cloneUsageTally(a.usage) : undefined })),
        tasks: prevState.tasks.map((t) => ({ ...t, artifacts: [...t.artifacts], toolsUsed: [...t.toolsUsed], usage: t.usage ? cloneUsageTally(t.usage) : undefined })),
        meetings: prevState.meetings.map((m) => ({ ...m, agenda: [...m.agenda], decisions: [...m.decisions], messages: [...m.messages] })),
        events: [...prevState.events],
        totalTokens: { ...prevState.totalTokens },
        usage: cloneUsageTally(prevState.usage),
        roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
        socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
      };

      step.execute(nextState);
      return nextState;
    });

    setDemoStepIndex(stepIdx);
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSimState((prevState) => {
        const nextState: SimulationState = {
          ...prevState,
          agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null, usage: a.usage ? cloneUsageTally(a.usage) : undefined })),
          tasks: prevState.tasks.map((t) => ({ ...t, usage: t.usage ? cloneUsageTally(t.usage) : undefined })),
          meetings: prevState.meetings.map((meeting) => ({
            ...meeting,
            participants: [...meeting.participants],
            agenda: [...meeting.agenda],
            decisions: [...meeting.decisions],
            tasksCreated: [...meeting.tasksCreated],
            messages: [...meeting.messages],
          })),
          events: [...prevState.events],
          totalTokens: { ...prevState.totalTokens },
          usage: cloneUsageTally(prevState.usage),
          roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
          socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
          coffeeSeatAssignments: prevState.coffeeSeatAssignments ? [...prevState.coffeeSeatAssignments] : [],
        };
        advanceLivingOffice(nextState, Date.now(), localeRef.current);
        return nextState;
      });
    }, 750);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ambientSocialEnabled) return;

    const timer = window.setInterval(() => {
      setSimState((prevState) => {
        const nextState: SimulationState = {
          ...prevState,
          agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null, usage: a.usage ? cloneUsageTally(a.usage) : undefined })),
          tasks: prevState.tasks.map((t) => ({ ...t, usage: t.usage ? cloneUsageTally(t.usage) : undefined })),
          meetings: prevState.meetings,
          events: [...prevState.events],
          totalTokens: { ...prevState.totalTokens },
          usage: cloneUsageTally(prevState.usage),
          roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
          socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
          coffeeSeatAssignments: prevState.coffeeSeatAssignments ? [...prevState.coffeeSeatAssignments] : [],
        };
        applyAmbientLife(nextState, Date.now(), locale, {
          enabled: ambientSocialEnabled,
          politicsEnabled: politicsChatterEnabled,
          idleGraceMs: 12000,
          minIntervalMs: 18000,
        });
        return nextState;
      });
    }, 4000);

    return () => window.clearInterval(timer);
  }, [ambientSocialEnabled, politicsChatterEnabled, locale]);

  useEffect(() => {
    if (!apiBase) {
      // Not streaming, but a token in the address still leaves the address bar and the history entry.
      takeLiveCredentials(window);
      setIsLiveConnected(false);
      setLiveTokenState({ resolved: false });
      return;
    }

    // The token leaves the address bar as soon as it is read (see liveConnection.ts).
    let cancelled = false;
    const abortController = new AbortController();
    let connection: ReturnType<typeof connectEventStream> | undefined;
    setLivePhase('loading');
    setLiveTokenState({ resolved: false });

    void loadLiveToken(window, apiBase).then(async (token) => {
      if (cancelled) return;
      setLiveTokenState({ resolved: true, token });

      // Load order on open (issue #72): the server's own record, through the snapshot and a deeper page of
      // events, before ever subscribing to the stream. A reload or a second tab must never start from an empty
      // office while the server already has the whole history.
      let history: Awaited<ReturnType<typeof loadLiveHistory>>;
      try {
        history = await loadLiveHistory(apiBase, {
          token,
          locale: localeRef.current,
          maxEvents: LIVE_HISTORY_LIMIT,
          signal: abortController.signal,
        });
      } catch (err) {
        if (cancelled || abortController.signal.aborted) return;
        console.error('[agent-viewer] Live history load failed:', err);
        // Never subscribes without a cursor on a failed load: that would present a partial history as complete.
        setLivePhase('error');
        return;
      }
      if (cancelled) return;

      setSimState(history.state);
      setLivePhase('subscribing');

      connection = connectEventStream(apiBase, (incoming) => {
        setIsLiveConnected(true);
        setSimState((prevState) => {
          const nextState: SimulationState = {
            ...prevState,
            agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null, usage: a.usage ? cloneUsageTally(a.usage) : undefined })),
            tasks: prevState.tasks.map((task) => ({ ...task, artifacts: [...task.artifacts], toolsUsed: [...task.toolsUsed], collaboratorIds: [...task.collaboratorIds], usage: task.usage ? cloneUsageTally(task.usage) : undefined })),
            meetings: prevState.meetings.map((meeting) => ({
              ...meeting,
              participants: [...meeting.participants],
              agenda: [...meeting.agenda],
              decisions: [...meeting.decisions],
              tasksCreated: [...meeting.tasksCreated],
              messages: [...meeting.messages],
            })),
            events: [...prevState.events],
            totalTokens: { ...prevState.totalTokens },
            usage: cloneUsageTally(prevState.usage),
            roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
            socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
          };
          applyExternalEvent(nextState, incoming, { locale: localeRef.current });
          return nextState;
        });
      }, (status) => {
        if (cancelled) return;
        if (status === 'connected') setLivePhase('live');
        else if (status === 'reconnecting' || status === 'disconnected') setLivePhase('reconnecting');
        else if (status === 'error') setLivePhase('error');
        else if (status === 'resyncing') setLivePhase('subscribing');
      }, {
        token,
        // Resumes from the newest event the history load actually received (issue #72), never from a different
        // request, so the portal never claims to have seen an event it did not load.
        lastEventId: history.lastEventId ?? undefined,
        // The server could not replay everything missed (issue #54): reload from `GET /api/v1/snapshot` instead
        // of trusting the 100 events it carries. Usage figures come from the snapshot's own aggregates, never
        // from re-adding those events, so a long gap never shows a silently lower total.
        onResync: async (info) => {
          try {
            const response = await fetch(`${apiBase}/api/v1/snapshot`, {
              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            if (!response.ok) throw new Error(`Snapshot reload failed with status ${response.status}`);
            const snapshot = (await response.json()) as LiveSnapshot;
            const nextState = rebuildFromSnapshot(snapshot, { locale: localeRef.current });
            if (cancelled) return undefined;
            setSimState(nextState);
            setResyncNotice({ missed: info.missed });
            return snapshot.lastEventId ?? null;
          } catch (err) {
            console.error('[agent-viewer] Resync snapshot reload failed:', err);
            // Leaves the cursor unset: onResync is called again on the next resync, and the office keeps
            // streaming live events in the meantime, with a notice already shown for the gap it does know about.
            return undefined;
          }
        },
      });
    });

    return () => {
      cancelled = true;
      abortController.abort();
      connection?.close();
      setIsLiveConnected(false);
      setResyncNotice(null);
    };
  }, [apiBase, isLiveMode, historyRetryToken]);

  // Demo playback timer
  useEffect(() => {
    if (!isPlayingDemo) return;

    const currentStep = demoSteps[demoStepIndex];
    const duration = (currentStep ? currentStep.durationMs : 4000) / playbackSpeed;

    const timer = setTimeout(() => {
      if (demoStepIndex < demoSteps.length - 1) {
        executeStep(demoStepIndex + 1);
      } else {
        setIsPlayingDemo(false);
      }
    }, duration);

    return () => clearTimeout(timer);
  }, [isPlayingDemo, demoStepIndex, playbackSpeed]);

  const handleTogglePlayDemo = () => {
    if (!isPlayingDemo && demoStepIndex >= demoSteps.length - 1) {
      // Loop from beginning if at the end
      executeStep(0);
      setIsPlayingDemo(true);
      return;
    }

    if (!isPlayingDemo && demoStepIndex === 0 && simState.tasks.length === 0) {
      executeStep(0);
    }

    setIsPlayingDemo((prev) => !prev);
  };

  const handleStepForward = () => {
    if (demoStepIndex < demoSteps.length - 1) {
      executeStep(demoStepIndex + 1);
    }
  };

  const handleResetDemo = () => {
    setIsPlayingDemo(false);
    setDemoStepIndex(0);
    clearSession(window.localStorage);
    setSimState(createInitialSimulationState(INITIAL_AGENTS, locale));
    setSelectedAgentId(null);
  };

  // Agent Operator Actions
  const handleSendMessageToAgent = (agentId: string, message: string) => {
    setSimState((prev) => {
      const nextAgents = prev.agents.map((a) => {
        if (a.id === agentId) {
          return {
            ...a,
            speechBubble: {
              text: message,
              expiresAt: Date.now() + 5000,
            },
          };
        }
        return a;
      });

      const nextEvents: ViewerEvent[] = [
        {
          id: `evt-user-msg-${Date.now()}`,
          type: 'message.sent',
          timestamp: Date.now(),
          source: 'operator',
          target: agentId,
          severity: 'normal',
          summary: t(locale, 'operator.messageEvent', { agent: agentName(prev.agents, agentId), message }),
          payload: { text: message },
        },
        ...prev.events,
      ];

      return {
        ...prev,
        agents: nextAgents,
        events: nextEvents,
      };
    });
  };

  const handleUpdateAgentStatus = (agentId: string, status: AgentStatus) => {
    setSimState((prev) => {
      const nextAgents = prev.agents.map((a) => {
        if (a.id === agentId) {
          return {
            ...a,
            status,
            statusText: t(locale, 'operator.statusText', { status: statusLabel(status) }),
          };
        }
        return a;
      });

      const nextEvents: ViewerEvent[] = [
        {
          id: `evt-status-${Date.now()}`,
          type: 'agent.status.changed',
          timestamp: Date.now(),
          source: 'operator',
          target: agentId,
          severity: 'normal',
          summary: t(locale, 'operator.statusEvent', { agent: agentName(prev.agents, agentId), status: statusLabel(status) }),
          payload: { status },
        },
        ...prev.events,
      ];

      return {
        ...prev,
        agents: nextAgents,
        events: nextEvents,
      };
    });
  };

  const handleFocusAgent = (agent: Agent) => {
    setCurrentTab('office');
    setSelectedAgentId(agent.id);
  };

  // Open Model Ops & Token telemetry console
  const handleOpenModelOps = (providerFilter?: string) => {
    setModelOpsInitialProvider(providerFilter || null);
    setIsModelOpsOpen(true);
  };

  // Record a Model Ops simulator what-if call. Never touches agent counters, office totals or `events`: a
  // simulated call is a sandbox figure, not usage. Only a speech bubble on the matching agent is visual.
  const handleSimulateCall = (call: SimulatedCall) => {
    setSimulatedCalls((prev) => recordSimulatedCall(prev, call));

    if (!call.agentId) return;
    setSimState((prev) => {
      const targetAgent = prev.agents.find((a) => a.id === call.agentId);
      if (!targetAgent) return prev;

      const nextAgents = prev.agents.map((a) => {
        if (a.id !== targetAgent.id) return a;
        return {
          ...a,
          speechBubble: {
            text: t(locale, 'operator.simulatedBubble', {
              tokens: (call.inputTokens + call.outputTokens).toLocaleString(locale),
              model: call.model,
            }),
            expiresAt: Date.now() + 4000,
          },
        };
      });

      return { ...prev, agents: nextAgents };
    });
  };

  // Reassign agent model interactively from Model Ops. Demo mode only: the portal cannot change the model
  // of a remote agent, so this is a no-op in live mode (the modal also hides the control there).
  const handleChangeAgentModel = (agentId: string, newProvider: string, newModel: string) => {
    if (isLiveMode) return;
    setSimState((prev) => {
      const nextAgents = prev.agents.map((a) => {
        if (a.id === agentId) {
          return {
            ...a,
            provider: newProvider,
            model: newModel,
            statusText: t(locale, 'operator.modelStatusText', { model: newModel, provider: newProvider }),
            speechBubble: {
              text: t(locale, 'operator.modelBubble', { model: newModel, provider: newProvider }),
              expiresAt: Date.now() + 4500,
            },
          };
        }
        return a;
      });

      const reassignEvent: ViewerEvent = {
        id: `evt-reassign-${Date.now()}`,
        type: 'agent.status.changed',
        timestamp: Date.now(),
        source: 'operator',
        target: agentId,
        severity: 'normal',
        summary: t(locale, 'operator.modelEvent', { model: newModel, provider: newProvider }),
        payload: { agentId, newProvider, newModel },
      };

      return {
        ...prev,
        agents: nextAgents,
        events: [reassignEvent, ...prev.events],
      };
    });
  };

  // Submit custom task
  const handleCreateCustomTask = (
    title: string,
    description: string,
    assignedRole: 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst'
  ) => {
    setSimState((prev) => {
      const nextState: SimulationState = {
        ...prev,
        agents: prev.agents.map((a) => ({ ...a })),
        tasks: [...prev.tasks],
        events: [...prev.events],
        totalTokens: { ...prev.totalTokens },
      };
      triggerCustomTaskSimulation(nextState, title, description, assignedRole, locale, {
        countUsage: !isLiveMode,
      });
      return nextState;
    });
  };

  // Export full telemetry session
  const handleExportSession = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' +
      encodeURIComponent(JSON.stringify(simState, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `agent_viewer_session_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Keyboard Shortcuts (F = focus agent, Space = pause/play demo, Esc = close inspector)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        setSelectedAgentId(null);
        setIsSettingsOpen(false);
        setIsNewTaskOpen(false);
        setIsModelOpsOpen(false);
        setDetailModalAgentId(null);
        setDetailModalInitialTab(null);
      } else if (e.key === ' ') {
        e.preventDefault();
        handleTogglePlayDemo();
      } else if (e.key === 'm' || e.key === 'M') {
        setCurrentTab('meetings');
      } else if (e.key === 't' || e.key === 'T') {
        setCurrentTab('tasks');
      } else if (e.key === 'o' || e.key === 'O') {
        setCurrentTab('office');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlayingDemo, demoStepIndex]);

  const selectedAgent = simState.agents.find((a) => a.id === selectedAgentId) || null;
  const activeMeetingCount = simState.meetings.filter((m) => m.status === 'ACTIVE').length;
  const overflowReservations = simState.roomReservations.filter((reservation) => reservation.floor === 2);
  const mainFloorAgents = simState.agents.filter((agent) => (agent.floor ?? 1) === 1);
  // The canvas draws the role title of agents without a built-in role: show the demo ones in the current language.
  const canvasAgents = mainFloorAgents.map((agent) => {
    const roleTitle = localizeDemoText(agent.roleTitle, locale);
    return roleTitle === agent.roleTitle ? agent : { ...agent, roleTitle };
  });

  // Per-agent spend badges drawn on the canvas (issue #78), built only from the ledger rollup: an agent with no
  // row in `byAgent` gets no badge at all (not an "unknown" one), since it recorded no calls in this window.
  // Hidden entirely while `showUsageBadges` is off (display preference, never gating the top-bar total).
  let agentBadges: Map<string, AgentBadge> | undefined;
  if (showUsageBadges && officeLedgerUsage?.byAgent) {
    const badges = new Map<string, AgentBadge>();
    for (const agent of canvasAgents) {
      const figures = officeLedgerUsage.byAgent[agent.id];
      if (!figures) continue;
      const badge = formatUsageBadge(figures, locale, officeTranslate);
      badges.set(agent.id, { tokens: badge.tokens, costLabel: badge.costLabel, failed: badge.failed });
    }
    if (badges.size > 0) agentBadges = badges;
  }
  // While the ledger has ever answered, the badges are the only source of truth: the canvas, top bar, inspector
  // etc. must stop drawing figures summed from local agents so nothing on screen contradicts a badge.
  const usageSummary = officeLedgerUsage?.total
    ? {
        tokens: formatTokens(officeLedgerUsage.total.totalTokens, locale, officeTranslate),
        cost: formatCost(officeLedgerUsage.total.cost, officeLedgerUsage.total.currency, locale, officeTranslate),
        windowLabel: t(locale, `usage.window.${usageWindow}` as TranslationKey),
      }
    : undefined;

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    setDropError(null);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    try {
      const parsed = await parseEventLog(file);
      if (parsed.events.length === 0) {
        const key = getDropErrorKey(parsed) || 'drop.noEvents';
        setDropError(t(locale, key as Parameters<typeof t>[1]));
        return;
      }
      // Replay all events into a fresh state
      const nextState = createLiveSimulationState();
      for (const evt of parsed.events) {
        applyExternalEvent(nextState, evt, { locale });
      }
      setSimState(nextState);
      setLastSource('replay');
    } catch (err: any) {
      setDropError(err?.message || t(locale, 'drop.readFailed'));
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleFileDrop}
      className={`w-screen h-screen flex flex-col bg-slate-950 font-sans overflow-hidden select-none relative ${theme}`}
    >
      {/* Drag & drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-slate-950/85 backdrop-blur-sm border-2 border-dashed border-sky-400 flex flex-col items-center justify-center text-sky-200">
          <Upload className="w-12 h-12 mb-3 animate-bounce text-sky-400" aria-hidden="true" />
          <p className="text-lg font-bold">{t(locale, 'drop.title')}</p>
          <p className="text-sm text-slate-300 mt-1">{t(locale, 'drop.subtitle')}</p>
        </div>
      )}

      {/* File error toast */}
      {dropError && (
        <div role="alert" className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-rose-950/90 border border-rose-700 text-rose-200 text-xs px-4 py-2.5 rounded-xl shadow-2xl">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
          <span>{dropError}</span>
          <button
            type="button"
            onClick={() => setDropError(null)}
            aria-label={t(locale, 'drop.dismiss')}
            title={t(locale, 'drop.dismiss')}
            className="ml-3 text-rose-300 hover:text-white font-bold"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Top Bar (Follows Top Bar Contract) */}
      <TopBar
        currentTab={currentTab}
        onTabChange={(tab) => setCurrentTab(tab)}
        isPlayingDemo={isPlayingDemo}
        demoStepIndex={demoStepIndex}
        totalDemoSteps={demoSteps.length}
        playbackSpeed={playbackSpeed}
        onTogglePlayDemo={handleTogglePlayDemo}
        onStepForward={handleStepForward}
        onResetDemo={handleResetDemo}
        onChangeSpeed={(spd) => setPlaybackSpeed(spd)}
        totalTokens={{
          input: simState.totalTokens.input,
          output: simState.totalTokens.output,
        }}
        totalCost={simState.totalCost}
        usageSummary={usageSummary}
        usageWindow={isLiveMode ? usageWindow : undefined}
        onChangeUsageWindow={isLiveMode ? handleChangeUsageWindow : undefined}
        isUsageStale={isUsageStale}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenNewTask={() => setIsNewTaskOpen(true)}
        activeMeetingCount={activeMeetingCount}
        locale={locale}
        onChangeLocale={setLocale}
        onOpenModelOps={() => handleOpenModelOps()}
        isLiveMode={isLiveMode}
        isLiveConnected={isLiveConnected}
        livePhase={livePhase}
        onRetryHistory={() => setHistoryRetryToken((n) => n + 1)}
        openApi={serverAuth === 'open'}
      />
      {isLiveMode && serverAuth === 'open' && <OpenApiBanner locale={locale} />}
      {isLiveMode && resyncNotice && (
        <ResyncNotice locale={locale} missed={resyncNotice.missed} onDismiss={() => setResyncNotice(null)} />
      )}

      {currentTab === 'office' && <div role="group" aria-label={locale.startsWith('es') ? 'Modo visual' : 'Visual mode'}
        className="flex gap-2 items-center justify-center p-2 bg-slate-900 text-white">
        <button type="button" aria-pressed={visualMode === 'cartoon'}
          className={visualMode === 'cartoon' ? 'rounded bg-violet-700 px-3 py-1' : 'rounded bg-slate-700 px-3 py-1'}
          onClick={() => setVisualMode('cartoon')}>{locale.startsWith('es') ? 'Caricatura' : 'Cartoon'}</button>
        <button type="button" aria-pressed={visualMode === 'crew'}
          className={visualMode === 'crew' ? 'rounded bg-violet-700 px-3 py-1' : 'rounded bg-slate-700 px-3 py-1'}
          onClick={() => setVisualMode('crew')}>Crew · Beta</button>
      </div>}

      {/* Main View Area */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Office View with Collapsible Vertical Live Timeline Sidebar */}
        {currentTab === 'office' && (
          <div className="flex-1 flex w-full h-full relative overflow-hidden">
            <div className="flex-1 h-full relative overflow-hidden">
              {visualMode === 'crew' ? (
                <CrewStage locale={locale} agents={canvasAgents} tasks={simState.tasks} meetings={simState.meetings}
                  viewerMode={crewViewerMode}
                  selectedRoomId={crewNavigation.selectedRoomId} onRoomChange={setCrewRoom}
                  missingRoom={crewMissingRoom} preferences={crewPreferences} onPreferencesChange={setCrewPreferences} />
              ) : currentFloor === 1 ? (
                <>
                  <OfficeCanvas
                    cameraMemory={cartoonCameraMemory}
                    agents={canvasAgents}
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={(id) => {
                      setSelectedAgentId(id);
                      if (!isSidebarOpen) setIsSidebarOpen(true);
                    }}
                    onDoubleClickAgent={(id) => openDetailModal(id)}
                    onOpenModelOps={handleOpenModelOps}
                    activeMeetingId={simState.activeMeetingId}
                    theme={theme}
                    translate={officeTranslate}
                    usageTelemetry={!officeLedgerUsage}
                    agentBadges={agentBadges}
                    isInspectorOpen={isSidebarOpen}
                    isSidebarOpen={isSidebarOpen}
                    onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
                  />
                  {overflowReservations.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCurrentFloor(2)}
                      className="absolute bottom-5 right-5 z-30 flex items-center gap-2 rounded-xl border border-violet-700/60 bg-slate-950/95 px-3 py-2 text-xs font-semibold text-violet-200 shadow-xl hover:bg-violet-950/70"
                      title={t(locale, 'floor.secret')}
                    >
                      <DoorOpen className="w-4 h-4" aria-hidden="true" />
                      <span>{t(locale, 'floor.enterSecret')}</span>
                      <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">
                        {overflowReservations.length}
                      </span>
                    </button>
                  )}
                </>
              ) : (
                <OverflowFloorView
                  locale={locale}
                  reservations={simState.roomReservations}
                  meetings={simState.meetings}
                  agents={simState.agents}
                  onBack={() => setCurrentFloor(1)}
                  onSelectAgent={(id) => setSelectedAgentId(id)}
                />
              )}
            </div>

            {/* Collapsible Vertical Activity Timeline & Inspector Sidebar */}
            <div className={visualMode === 'crew' ? 'hidden lg:contents' : 'contents'}>
              <LiveTimelineSidebar
                isOpen={isSidebarOpen}
                onToggleOpen={() => setIsSidebarOpen((prev) => !prev)}
                events={simState.events}
                agents={simState.agents}
                tasks={simState.tasks}
                activeMeetingId={simState.activeMeetingId}
                selectedAgent={selectedAgent}
                onSelectAgent={(id) => setSelectedAgentId(id)}
                onFocusAgent={handleFocusAgent}
                onSendMessage={handleSendMessageToAgent}
                onUpdateStatus={handleUpdateAgentStatus}
                onOpenAgentDetailModal={(id, tab) => openDetailModal(id, tab)}
                theme={theme}
                locale={locale}
                usageFigures={selectedAgent ? officeLedgerUsage?.byAgent?.[selectedAgent.id] : undefined}
                ledgerReady={Boolean(officeLedgerUsage)}
                isStale={isUsageStale}
              />
            </div>
          </div>
        )}

        {/* Tasks & DAG */}
        {currentTab === 'tasks' && (
          <TaskBoard
            tasks={simState.tasks}
            agents={simState.agents}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setCurrentTab('office');
            }}
            onOpenAgentDetail={(id) => openDetailModal(id)}
            onOpenNewTask={() => setIsNewTaskOpen(true)}
            locale={locale}
          />
        )}

        {/* Meetings */}
        {currentTab === 'meetings' && (
          <MeetingRoomModal
            meetings={simState.meetings}
            activeMeetingId={simState.activeMeetingId}
            agents={simState.agents}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setCurrentTab('office');
            }}
            locale={locale}
            events={simState.events}
            ledger={ledgerConnection}
          />
        )}

        {/* Activity Timeline */}
        {currentTab === 'timeline' && (
          <ActivityTimeline
            events={simState.events}
            agents={simState.agents}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setCurrentTab('office');
            }}
            locale={locale}
          />
        )}

        {/* Agent Inspector for other tabs (Tasks, Meetings, Timeline) */}
        {currentTab !== 'office' && selectedAgent && (
          <AgentInspector
            agent={selectedAgent}
            onClose={() => setSelectedAgentId(null)}
            onFocusAgent={handleFocusAgent}
            onSendMessage={handleSendMessageToAgent}
            onUpdateStatus={handleUpdateAgentStatus}
            onOpenDetailModal={(id, tab) => openDetailModal(id, tab)}
            events={simState.events}
            locale={locale}
            ledger={ledgerConnection}
            usageFigures={officeLedgerUsage?.byAgent?.[selectedAgent.id]}
            ledgerReady={Boolean(officeLedgerUsage)}
            isStale={isUsageStale}
          />
        )}
      </main>

      {/* Settings & Pricing Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        pricing={pricing}
        onUpdatePricing={(newPricing) => setPricing(newPricing)}
        onResetSession={handleResetDemo}
        onExportSession={handleExportSession}
        ambientSocialEnabled={ambientSocialEnabled}
        onAmbientSocialEnabledChange={setAmbientSocialEnabled}
        politicsChatterEnabled={politicsChatterEnabled}
        onPoliticsChatterEnabledChange={setPoliticsChatterEnabled}
        maskSecrets={maskSecrets}
        onMaskSecretsChange={handleChangeMaskSecrets}
        showUsageBadges={showUsageBadges}
        onShowUsageBadgesChange={handleChangeShowUsageBadges}
        locale={locale}
      />

      {/* New Task Dispatch Modal */}
      <NewTaskModal
        isOpen={isNewTaskOpen}
        onClose={() => setIsNewTaskOpen(false)}
        agents={simState.agents}
        locale={locale}
        onSubmitTask={handleCreateCustomTask}
      />

      {/* Interactive Model Ops & Token Operations Center Modal */}
      <ModelOpsModal
        isOpen={isModelOpsOpen}
        onClose={() => setIsModelOpsOpen(false)}
        agents={simState.agents}
        onFocusAgent={handleFocusAgent}
        onSimulateCall={handleSimulateCall}
        simulatedCalls={simulatedCalls}
        onChangeAgentModel={handleChangeAgentModel}
        initialProviderFilter={modelOpsInitialProvider}
        events={simState.events}
        locale={locale}
        isLiveMode={isLiveMode}
        ledger={ledgerConnection}
      />

      {/* Comprehensive Agent Detail Modal (Double click on agent) */}
      <AgentDetailModal
        isOpen={Boolean(detailModalAgentId)}
        agent={simState.agents.find((a) => a.id === detailModalAgentId) || null}
        allAgents={simState.agents}
        tasks={simState.tasks}
        events={simState.events}
        pricing={pricing}
        onClose={() => {
          setDetailModalAgentId(null);
          setDetailModalInitialTab(null);
        }}
        onSelectAgent={(id) => setSelectedAgentId(id)}
        onFocusAgent={handleFocusAgent}
        onSendMessage={handleSendMessageToAgent}
        onUpdateStatus={handleUpdateAgentStatus}
        locale={locale}
        ledger={ledgerConnection}
        usageFigures={
          detailModalAgentId ? officeLedgerUsage?.byAgent?.[detailModalAgentId] : undefined
        }
        ledgerReady={Boolean(officeLedgerUsage)}
        isStale={isUsageStale}
        usageWindow={usageWindow}
        maskSecrets={maskSecrets}
        initialTab={detailModalInitialTab ?? undefined}
      />
    </div>
  );
}
