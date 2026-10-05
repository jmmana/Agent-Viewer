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

export default function App() {
  // Master Simulation State
  const [simState, setSimState] = useState<SimulationState>(() =>
    createInitialSimulationState(INITIAL_AGENTS)
  );

  // Active navigation tab
  const [currentTab, setCurrentTab] = useState<'office' | 'tasks' | 'meetings' | 'timeline'>('office');

  // Collapsible vertical live timeline sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Selected agent for Inspector
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Demo Playback Engine state
  const [isPlayingDemo, setIsPlayingDemo] = useState(false);
  const [demoStepIndex, setDemoStepIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [pricing, setPricing] = useState<PricingConfig[]>(DEFAULT_PRICING);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

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
      };

      DEMO_STEPS[stepIdx].execute(nextState);
      return nextState;
    });

    setDemoStepIndex(stepIdx);
  };

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
      />

      {/* Main View Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Office View with Collapsible Vertical Live Timeline Sidebar */}
        {currentTab === 'office' && (
          <div className="flex-1 flex w-full h-full relative overflow-hidden">
            <div className="flex-1 h-full relative overflow-hidden">
              <OfficeCanvas
                agents={simState.agents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={(id) => {
                  setSelectedAgentId(id);
                  if (!isSidebarOpen) setIsSidebarOpen(true);
                }}
                activeMeetingId={simState.activeMeetingId}
                theme={theme}
                isInspectorOpen={isSidebarOpen}
                isSidebarOpen={isSidebarOpen}
                onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
              />
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
            onOpenNewTask={() => setIsNewTaskOpen(true)}
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
      />

      {/* New Task Dispatch Modal */}
      <NewTaskModal
        isOpen={isNewTaskOpen}
        onClose={() => setIsNewTaskOpen(false)}
        agents={simState.agents}
        onSubmitTask={handleCreateCustomTask}
      />
    </div>
  );
}
