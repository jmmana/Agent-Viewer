import React from 'react';
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  Plus,
  Volume2,
  VolumeX,
  Sun,
  Moon,
  Settings,
  Sparkles,
  Layers,
  Activity,
  Users,
  CheckCircle2,
} from 'lucide-react';
import { isSoundEnabled, setSoundEnabled } from '../engine/soundEffects';

interface TopBarProps {
  currentTab: 'office' | 'tasks' | 'meetings' | 'timeline';
  onTabChange: (tab: 'office' | 'tasks' | 'meetings' | 'timeline') => void;
  isPlayingDemo: boolean;
  demoStepIndex: number;
  totalDemoSteps: number;
  playbackSpeed: number;
  onTogglePlayDemo: () => void;
  onStepForward: () => void;
  onResetDemo: () => void;
  onChangeSpeed: (speed: number) => void;
  totalTokens: { input: number; output: number };
  totalCost: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenNewTask: () => void;
  activeMeetingCount: number;
}

export const TopBar: React.FC<TopBarProps> = ({
  currentTab,
  onTabChange,
  isPlayingDemo,
  demoStepIndex,
  totalDemoSteps,
  playbackSpeed,
  onTogglePlayDemo,
  onStepForward,
  onResetDemo,
  onChangeSpeed,
  totalTokens,
  totalCost,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenNewTask,
  activeMeetingCount,
}) => {
  const [soundOn, setSoundOn] = React.useState(isSoundEnabled());

  const handleToggleSound = () => {
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
  };

  const formattedTokens = ((totalTokens.input + totalTokens.output) / 1000).toFixed(1) + 'K';
  const formattedCost = `$${totalCost.toFixed(3)}`;

  return (
    <header className="flex flex-wrap gap-2 items-center justify-between px-3 sm:px-5 py-2.5 bg-slate-900 border-b border-slate-800 text-slate-100 select-none z-30 shrink-0">
      {/* Zone 1: Single text element Brand mark */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-sm shadow-indigo-500/20">
            <span className="text-xs tracking-tighter font-mono">AV</span>
          </div>
          <span className="text-base font-bold tracking-tight text-white font-sans">
            Agent Viewer
          </span>
        </div>
        <div className="h-4 w-px bg-slate-700" />
        <span className="text-xs text-slate-400 hidden 2xl:inline">
          Virtual Office · Simulation
        </span>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200" title="Actividad, tokens y costos generados por la simulación local">DEMO</span>
      </div>

      {/* Zone 2: Navigation Links (Single-line, clean tabs) */}
      <nav className="flex max-w-full overflow-x-auto items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800/80">
        <button
          onClick={() => onTabChange('office')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'office'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Users className="w-3.5 h-3.5 text-sky-400" />
          <span>Office View</span>
        </button>

        <button
          onClick={() => onTabChange('tasks')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'tasks'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-indigo-400" />
          <span>Tasks & DAG</span>
        </button>

        <button
          onClick={() => onTabChange('meetings')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap relative ${
            currentTab === 'meetings'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span>Meetings</span>
          {activeMeetingCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ml-0.5" />
          )}
        </button>

        <button
          onClick={() => onTabChange('timeline')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'timeline'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-3.5 h-3.5 text-amber-400" />
          <span>Activity Timeline</span>
        </button>
      </nav>

      {/* Zone 3: Demo Controls & Telemetry Stats */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Live Replay / Demo Controls */}
        <div className="flex items-center gap-1.5 bg-slate-950/80 px-2 py-1 rounded-lg border border-slate-800">
          <button
            onClick={onTogglePlayDemo}
            title={isPlayingDemo ? 'Pause sequence' : 'Play demonstration sequence'}
            className={`p-1.5 rounded transition-colors ${
              isPlayingDemo
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            }`}
          >
            {isPlayingDemo ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>

          <button
            onClick={onStepForward}
            title="Step to next event"
            disabled={isPlayingDemo || demoStepIndex >= totalDemoSteps - 1}
            className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onResetDemo}
            title="Reset simulation to initial state"
            className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Speed selector */}
          <div className="flex items-center text-[11px] font-mono text-slate-400 ml-1">
            {[1, 2, 5].map((spd) => (
              <button
                key={spd}
                onClick={() => onChangeSpeed(spd)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  playbackSpeed === spd
                    ? 'text-sky-400 font-semibold bg-sky-500/10'
                    : 'hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          <span className="text-[11px] font-mono text-slate-500 px-1 border-l border-slate-800 tabular-nums">
            Step {demoStepIndex + 1}/{totalDemoSteps}
          </span>
        </div>

        {/* Global Live Tokens & Cost Pill (Unboxed text with tabular numerals) */}
        <div className="flex items-center gap-2 text-xs font-mono tabular-nums bg-slate-950/60 px-2.5 py-1.5 rounded-lg border border-slate-800/80">
          <div className="flex items-center gap-1 text-slate-300">
            <span className="text-slate-500">Tokens</span>
            <span className="text-sky-400 font-semibold">{formattedTokens}</span>
          </div>
          <span className="text-slate-700">·</span>
          <div className="flex items-center gap-1 text-slate-300">
            <span className="text-slate-500">Cost</span>
            <span className="text-emerald-400 font-semibold">{formattedCost}</span>
          </div>
        </div>

        {/* Action: New Task */}
        <button
          onClick={onOpenNewTask}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm shadow-indigo-600/20 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Task</span>
        </button>

        {/* Audio Toggle */}
        <button
          onClick={handleToggleSound}
          title={soundOn ? 'Sound effects on' : 'Sound effects muted'}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
        >
          {soundOn ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4" />}
        </button>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          title="Configure pricing & environment"
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
