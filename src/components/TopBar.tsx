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
import { Locale, t } from '../i18n';

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
  locale: Locale;
  onChangeLocale: (locale: Locale) => void;
  onOpenModelOps?: () => void;
  isLiveMode?: boolean;
  isLiveConnected?: boolean;
  openApi?: boolean;
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
  locale,
  onChangeLocale,
  onOpenModelOps,
  isLiveMode = false,
  isLiveConnected = false,
  openApi = false,
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
          <div aria-hidden="true" className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-sm shadow-indigo-500/20">
            <span className="text-xs tracking-tighter font-mono">AV</span>
          </div>
          <h1 className="text-base font-bold tracking-tight text-white font-sans">
            Agent Viewer
          </h1>
        </div>
        <div className="h-4 w-px bg-slate-700" />
        <span className="text-xs text-slate-400 hidden 2xl:inline">
          {t(locale, 'app.subtitle')}
        </span>
        {isLiveConnected ? (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide flex items-center gap-1.5 ${
              openApi
                ? 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
            }`}
            title={t(locale, 'live.title')}
          >
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${openApi ? 'bg-amber-400' : 'bg-emerald-400'}`} aria-hidden="true" />
            {t(locale, 'live.badge')}
            {openApi && <span>{t(locale, 'security.openApi.label')}</span>}
          </span>
        ) : isLiveMode ? (
          <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-300">
            {t(locale, 'live.connecting')}
          </span>
        ) : (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200" title={t(locale, 'demo.title')}>
            {t(locale, 'demo.label')}
          </span>
        )}
      </div>

      {/* Zone 2: Navigation Links (Single-line, clean tabs) */}
      <nav aria-label={t(locale, 'nav.label')} className="flex max-w-full overflow-x-auto items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800/80">
        <button
          onClick={() => onTabChange('office')}
          aria-current={currentTab === 'office' ? 'page' : undefined}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'office'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Users className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
          <span>{t(locale, 'nav.office')}</span>
        </button>

        <button
          onClick={() => onTabChange('tasks')}
          aria-current={currentTab === 'tasks' ? 'page' : undefined}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'tasks'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
          <span>{t(locale, 'nav.tasks')}</span>
        </button>

        <button
          onClick={() => onTabChange('meetings')}
          aria-current={currentTab === 'meetings' ? 'page' : undefined}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap relative ${
            currentTab === 'meetings'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
          <span>{t(locale, 'nav.meetings')}</span>
          {activeMeetingCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ml-0.5" aria-hidden="true" />
          )}
        </button>

        <button
          onClick={() => onTabChange('timeline')}
          aria-current={currentTab === 'timeline' ? 'page' : undefined}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            currentTab === 'timeline'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          <span>{t(locale, 'nav.timeline')}</span>
        </button>
      </nav>

      {/* Zone 3: Demo Controls & Telemetry Stats */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Live Replay / Demo Controls (hidden in live mode) */}
        {!isLiveMode && (
          <div className="flex items-center gap-1.5 bg-slate-950/80 px-2 py-1 rounded-lg border border-slate-800">
            <button
              onClick={onTogglePlayDemo}
              title={isPlayingDemo ? t(locale, 'controls.pause') : t(locale, 'controls.play')}
              aria-label={isPlayingDemo ? t(locale, 'controls.pause') : t(locale, 'controls.play')}
              className={`p-1.5 rounded transition-colors ${
                isPlayingDemo
                  ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500'
              }`}
            >
              {isPlayingDemo ? <Pause className="w-3.5 h-3.5" aria-hidden="true" /> : <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />}
            </button>

            <button
              onClick={onStepForward}
              title={t(locale, 'controls.step')}
              aria-label={t(locale, 'controls.step')}
              disabled={isPlayingDemo || demoStepIndex >= totalDemoSteps - 1}
              className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              onClick={onResetDemo}
              title={t(locale, 'controls.reset')}
              aria-label={t(locale, 'controls.reset')}
              className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            {/* Speed selector */}
            <div role="group" aria-label={t(locale, 'controls.speedGroup')} className="flex items-center text-[11px] font-mono text-slate-300 ml-1">
              {[1, 2, 5].map((spd) => (
                <button
                  key={spd}
                  onClick={() => onChangeSpeed(spd)}
                  aria-pressed={playbackSpeed === spd}
                  aria-label={t(locale, 'controls.speedValue', { speed: spd })}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    playbackSpeed === spd
                      ? 'text-sky-300 font-semibold bg-sky-500/10'
                      : 'hover:text-slate-200'
                  }`}
                >
                  {t(locale, 'controls.speedShort', { speed: spd })}
                </button>
              ))}
            </div>

            <span className="text-[11px] font-mono text-slate-400 px-1 border-l border-slate-800 tabular-nums">
              {t(locale, 'controls.stepCounter', { label: t(locale, 'controls.stepLabel'), current: demoStepIndex + 1, total: totalDemoSteps })}
            </span>
          </div>
        )}

        {/* Global Live Tokens & Cost Pill (Interactive Model Ops Launcher) */}
        <button
          onClick={onOpenModelOps}
          title={t(locale, 'controls.modelOpsTitle')}
          className="flex items-center gap-2 text-xs font-mono tabular-nums bg-slate-950/80 hover:bg-slate-850 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-cyan-500/50 shadow-sm transition-all group cursor-pointer"
        >
          <div className="w-2 h-2 rounded-full bg-emerald-400 group-hover:bg-cyan-400 animate-pulse shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-1 text-slate-300">
            <span className="text-slate-400">{t(locale, 'controls.tokens')}</span>
            <span className="text-sky-400 font-semibold">{formattedTokens}</span>
          </div>
          <span className="text-slate-400" aria-hidden="true">·</span>
          <div className="flex items-center gap-1 text-slate-300">
            <span className="text-slate-400">{t(locale, 'controls.cost')}</span>
            <span className="text-emerald-400 font-semibold">{formattedCost}</span>
          </div>
          <span className="text-[10px] font-sans font-semibold text-cyan-300 group-hover:text-cyan-200 ml-1">
            {t(locale, 'controls.modelOpsLabel')}
          </span>
        </button>

        {/* Action: New Task */}
        <button
          onClick={onOpenNewTask}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm shadow-indigo-600/20 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t(locale, 'controls.newTask')}</span>
        </button>

        <select
          aria-label={t(locale, 'controls.language')}
          value={locale}
          onChange={(event) => onChangeLocale(event.target.value as Locale)}
          className="bg-slate-950/80 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200"
        >
          <option value="en" lang="en" aria-label={t(locale, 'controls.languageEn')}>EN</option>
          <option value="es" lang="es" aria-label={t(locale, 'controls.languageEs')}>ES</option>
        </select>

        {/* Audio Toggle */}
        <button
          onClick={handleToggleSound}
          title={soundOn ? t(locale, 'controls.soundOn') : t(locale, 'controls.soundMuted')}
          aria-label={soundOn ? t(locale, 'controls.soundOn') : t(locale, 'controls.soundMuted')}
          aria-pressed={soundOn}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
        >
          {soundOn ? <Volume2 className="w-4 h-4 text-emerald-400" aria-hidden="true" /> : <VolumeX className="w-4 h-4" aria-hidden="true" />}
        </button>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          title={t(locale, 'controls.settings')}
          aria-label={t(locale, 'controls.settings')}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
        >
          <Settings className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
};
