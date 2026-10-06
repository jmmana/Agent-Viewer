import React, { useState, useEffect, useRef } from 'react';
import { Agent, AgentStatus, PricingConfig, ViewerEvent } from './types/agent';
import { DEFAULT_PRICING, INITIAL_AGENTS } from './engine/officeModel';
import {
  createInitialSimulationState,
  DEMO_STEPS,
  SimulationState,
  triggerCustomTaskSimulation,
} from './engine/simulationEngine';
import { TopBar } from './components/TopBar';
import { OfficeCanvas } from './components/OfficeCanvas';
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
import { SimulatedTokenBurst } from './engine/modelOps';
import { DoorOpen } from 'lucide-react';
import { t } from './i18n';
import { detectLocale, Locale, persistLocale } from './i18n';
import { advanceLivingOffice, applyAmbientLife } from './engine/livingOfficeEngine';
import { applyExternalEvent } from './integrations/eventIngestion';
import { connectEventStream } from './integrations/realtimeClient';
import { clearSession, loadSession, saveSession } from './engine/sessionStorage';

export default function App() {
  // Master Simulation State
  const [simState, setSimState] = useState<SimulationState>(() => {
    const restored = typeof window !== 'undefined' ? loadSession(window.localStorage) : null;
    return restored ?? createInitialSimulationState(INITIAL_AGENTS);
  });

  // Active navigation tab
  const [currentTab, setCurrentTab] = useState<'office' | 'tasks' | 'meetings' | 'timeline'>('office');

  // Collapsible vertical live timeline sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 1024);

  // Selected agent for Inspector
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Model Ops Telemetry Modal state
  const [isModelOpsOpen, setIsModelOpsOpen] = useState(false);
  const [modelOpsInitialProvider, setModelOpsInitialProvider] = useState<string | null>(null);

  // Agent Detail Modal state (triggered on double click)
  const [detailModalAgentId, setDetailModalAgentId] = useState<string | null>(null);

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
  const [ambientSocialEnabled, setAmbientSocialEnabled] = useState(true);
  const [politicsChatterEnabled, setPoliticsChatterEnabled] = useState(false);
  const [currentFloor, setCurrentFloor] = useState<1 | 2>(1);

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveSession(window.localStorage, simState);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [simState]);

  // Keep a ref to current simulation state to avoid stale closure during step execution
  const simStateRef = useRef(simState);
  simStateRef.current = simState;

  // Execute a specific demo step
  const executeStep = (stepIdx: number) => {
    if (stepIdx < 0 || stepIdx >= DEMO_STEPS.length) return;

    setSimState((prevState) => {
      // Deep clone to update reactively
      const nextState: SimulationState = {
        ...prevState,
        agents: prevState.agents.map((a) => ({ ...a })),
        tasks: prevState.tasks.map((t) => ({ ...t, artifacts: [...t.artifacts], toolsUsed: [...t.toolsUsed] })),
        meetings: prevState.meetings.map((m) => ({ ...m, agenda: [...m.agenda], decisions: [...m.decisions], messages: [...m.messages] })),
        events: [...prevState.events],
        totalTokens: { ...prevState.totalTokens },
        roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
        socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
      };

      DEMO_STEPS[stepIdx].execute(nextState);
      return nextState;
    });

    setDemoStepIndex(stepIdx);
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSimState((prevState) => {
        const nextState: SimulationState = {
          ...prevState,
          agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null })),
          tasks: prevState.tasks,
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
          roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
          socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
          coffeeSeatAssignments: prevState.coffeeSeatAssignments ? [...prevState.coffeeSeatAssignments] : [],
        };
        advanceLivingOffice(nextState, Date.now());
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
          agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null })),
          tasks: prevState.tasks,
          meetings: prevState.meetings,
          events: [...prevState.events],
          totalTokens: { ...prevState.totalTokens },
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
    const apiBase = import.meta.env.VITE_AGENT_VIEWER_API_URL as string | undefined;
    if (!apiBase) return;

    const connection = connectEventStream(apiBase, (incoming) => {
      setSimState((prevState) => {
        const nextState: SimulationState = {
          ...prevState,
          agents: prevState.agents.map((a) => ({ ...a, speechBubble: a.speechBubble ? { ...a.speechBubble } : null })),
          tasks: prevState.tasks.map((task) => ({ ...task, artifacts: [...task.artifacts], toolsUsed: [...task.toolsUsed], collaboratorIds: [...task.collaboratorIds] })),
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
          roomReservations: prevState.roomReservations.map((r) => ({ ...r, participantIds: [...r.participantIds] })),
          socialActivities: prevState.socialActivities.map((a) => ({ ...a, participantIds: [...a.participantIds] })),
        };
        applyExternalEvent(nextState, incoming);
        return nextState;
      });
    });

    return () => connection.close();
  }, []);

  // Demo playback timer
  useEffect(() => {
    if (!isPlayingDemo) return;

    const currentStep = DEMO_STEPS[demoStepIndex];
    const duration = (currentStep ? currentStep.durationMs : 4000) / playbackSpeed;

    const timer = setTimeout(() => {
      if (demoStepIndex < DEMO_STEPS.length - 1) {
        executeStep(demoStepIndex + 1);
      } else {
        setIsPlayingDemo(false);
      }
    }, duration);

    return () => clearTimeout(timer);
  }, [isPlayingDemo, demoStepIndex, playbackSpeed]);

  const handleTogglePlayDemo = () => {
    if (!isPlayingDemo && demoStepIndex >= DEMO_STEPS.length - 1) {
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
    if (demoStepIndex < DEMO_STEPS.length - 1) {
      executeStep(demoStepIndex + 1);
    }
  };

  const handleResetDemo = () => {
    setIsPlayingDemo(false);
    setDemoStepIndex(0);
    clearSession(window.localStorage);
    setSimState(createInitialSimulationState(INITIAL_AGENTS));
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
          summary: `Operator instruction dispatched to ${agentId}: "${message}"`,
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
            statusText: `Operator forced status to ${status}`,
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
          summary: `Operator changed ${agentId} status to ${status}.`,
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

  // Ingest simulated or real token inference burst into live telemetry
  const handleSimulateTokenBurst = (burst: SimulatedTokenBurst) => {
    setSimState((prev) => {
      // Find an agent with that provider and model, or pick the first matching agent
      const targetAgent =
        prev.agents.find((a) => a.provider === burst.provider && a.model === burst.model) ||
        prev.agents.find((a) => a.provider === burst.provider) ||
        prev.agents[0];

      const nextAgents = prev.agents.map((a) => {
        if (a.id === targetAgent.id) {
          return {
            ...a,
            tokensInput: a.tokensInput + burst.inputTokens,
            tokensOutput: a.tokensOutput + burst.outputTokens,
            cachedTokens: a.cachedTokens + (burst.cachedTokens || 0),
            cost: a.cost + burst.cost,
            speechBubble: {
              text: `⚡ Inferencia: +${(burst.inputTokens + burst.outputTokens).toLocaleString()} tokens en ${burst.model}`,
              expiresAt: Date.now() + 4000,
            },
          };
        }
        return a;
      });

      const nextTotalTokens = {
        input: prev.totalTokens.input + burst.inputTokens,
        output: prev.totalTokens.output + burst.outputTokens,
        cached: prev.totalTokens.cached + (burst.cachedTokens || 0),
        reasoning: prev.totalTokens.reasoning,
      };

      const burstEvent: ViewerEvent = {
        id: `evt-burst-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        type: 'llm.usage',
        timestamp: Date.now(),
        source: targetAgent.id,
        target: 'server_room',
        severity: 'normal',
        summary: `Inferencia ejecutada en ${burst.provider} (${burst.model}): +${(burst.inputTokens + burst.outputTokens).toLocaleString()} tokens (${burst.latencyMs}ms, $${burst.cost.toFixed(4)})`,
        payload: burst,
      };

      return {
        ...prev,
        agents: nextAgents,
        totalTokens: nextTotalTokens,
        totalCost: prev.totalCost + burst.cost,
        events: [burstEvent, ...prev.events],
      };
    });
  };

  // Reassign agent model interactively from Model Ops
  const handleChangeAgentModel = (agentId: string, newProvider: string, newModel: string) => {
    setSimState((prev) => {
      const nextAgents = prev.agents.map((a) => {
        if (a.id === agentId) {
          return {
            ...a,
            provider: newProvider,
            model: newModel,
            statusText: `Modelo cambiado a ${newModel} (${newProvider})`,
            speechBubble: {
              text: `Cambié mi motor a ${newModel} (${newProvider})`,
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
        summary: `Agente reasignado: ${newModel} (${newProvider})`,
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
      triggerCustomTaskSimulation(nextState, title, description, assignedRole);
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

  return (
    <div className={`w-screen h-screen flex flex-col bg-slate-950 font-sans overflow-hidden select-none ${theme}`}>
      {/* Top Bar (Follows Top Bar Contract) */}
      <TopBar
        currentTab={currentTab}
        onTabChange={(tab) => setCurrentTab(tab)}
        isPlayingDemo={isPlayingDemo}
        demoStepIndex={demoStepIndex}
        totalDemoSteps={DEMO_STEPS.length}
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
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenNewTask={() => setIsNewTaskOpen(true)}
        activeMeetingCount={activeMeetingCount}
        locale={locale}
        onChangeLocale={setLocale}
        onOpenModelOps={() => handleOpenModelOps()}
      />

      {/* Main View Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Office View with Collapsible Vertical Live Timeline Sidebar */}
        {currentTab === 'office' && (
          <div className="flex-1 flex w-full h-full relative overflow-hidden">
            <div className="flex-1 h-full relative overflow-hidden">
              {currentFloor === 1 ? (
                <>
                  <OfficeCanvas
                    agents={mainFloorAgents}
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={(id) => {
                      setSelectedAgentId(id);
                      if (!isSidebarOpen) setIsSidebarOpen(true);
                    }}
                    onDoubleClickAgent={(id) => setDetailModalAgentId(id)}
                    onOpenModelOps={handleOpenModelOps}
                    activeMeetingId={simState.activeMeetingId}
                    theme={theme}
                    locale={locale}
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
                      <DoorOpen className="w-4 h-4" />
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
              onOpenAgentDetailModal={(id) => setDetailModalAgentId(id)}
              theme={theme}
            />
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
            onOpenAgentDetail={(id) => setDetailModalAgentId(id)}
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
            onOpenDetailModal={(id) => setDetailModalAgentId(id)}
            events={simState.events}
          />
        )}
      </div>

      {/* Floating Step Banner when playing demo */}
      {isPlayingDemo && DEMO_STEPS[demoStepIndex] && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-5 py-2.5 rounded-full border border-sky-500/40 shadow-2xl flex items-center gap-3 z-40 animate-in fade-in slide-in-from-top-2 duration-200">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping" />
          <div className="text-xs">
            <span className="font-bold text-white block">
              {DEMO_STEPS[demoStepIndex].title}
            </span>
            <span className="text-slate-400 text-[11px]">
              {DEMO_STEPS[demoStepIndex].description}
            </span>
          </div>
        </div>
      )}

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
        onSimulateTokenBurst={handleSimulateTokenBurst}
        onChangeAgentModel={handleChangeAgentModel}
        initialProviderFilter={modelOpsInitialProvider}
        events={simState.events}
      />

      {/* Comprehensive Agent Detail Modal (Double click on agent) */}
      <AgentDetailModal
        isOpen={Boolean(detailModalAgentId)}
        agent={simState.agents.find((a) => a.id === detailModalAgentId) || null}
        allAgents={simState.agents}
        tasks={simState.tasks}
        events={simState.events}
        pricing={pricing}
        onClose={() => setDetailModalAgentId(null)}
        onSelectAgent={(id) => setSelectedAgentId(id)}
        onFocusAgent={handleFocusAgent}
        onSendMessage={handleSendMessageToAgent}
        onUpdateStatus={handleUpdateAgentStatus}
      />
    </div>
  );
}
