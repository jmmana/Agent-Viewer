import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Agent, ViewerEvent } from '../types/agent';
import { OfficeCanvas } from '../components/OfficeCanvas';
import { Locale } from '../i18n';
import type { CanonicalEvent } from '../integrations/canonicalContract';
import { SessionReplayPlayer } from '../integrations/replayEngine';
import { createLiveSimulationState, type SimulationState } from '../engine/simulationEngine';
import { parseEventLog } from '../integrations/eventLogParser';
import { recordReplay, isRecordingSupported } from './recordReplay';
import { Play, Pause, RotateCcw, Video, Download, Upload, AlertCircle } from 'lucide-react';

export interface AgentOfficeProps {
  agents?: Agent[];
  events?: CanonicalEvent[] | ViewerEvent[];
  replayEvents?: CanonicalEvent[];
  locale?: Locale;
  messages?: Record<string, string>;
  t?: (key: string, params?: Record<string, any>) => string;
  theme?: 'dark' | 'light';
  mode?: 'live' | 'demo' | 'replay';
  showUsage?: boolean;
  onSelectAgent?: (agentId: string | null) => void;
  className?: string;
  activeMeetingId?: string | null;
  onVideoExport?: (blob: Blob) => void;
}

export const AgentOffice: React.FC<AgentOfficeProps> = ({
  agents: propAgents,
  events,
  replayEvents: initialReplayEvents,
  locale = 'en',
  theme = 'dark',
  mode: initialMode = 'live',
  showUsage = true,
  onSelectAgent,
  className = '',
  activeMeetingId: propMeetingId = null,
  onVideoExport,
}) => {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'live' | 'demo' | 'replay'>(initialMode);
  const [replayState, setReplayState] = useState<SimulationState>(() => createLiveSimulationState());
  const [isPlaying, setIsPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [progressRatio, setProgressRatio] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SessionReplayPlayer | null>(null);

  // Initialize player when replay events are passed
  const activeReplayEvents = useMemo(() => {
    if (initialReplayEvents && initialReplayEvents.length > 0) {
      return initialReplayEvents;
    }
    if (events && events.length > 0 && mode === 'replay') {
      return events as CanonicalEvent[];
    }
    return [];
  }, [initialReplayEvents, events, mode]);

  useEffect(() => {
    if (activeReplayEvents.length > 0) {
      const player = new SessionReplayPlayer(activeReplayEvents, {
        speed: replaySpeed,
        onStep: (_evt, idx, total) => {
          setProgressRatio(total > 0 ? (idx + 1) / total : 0);
        },
        onComplete: () => {
          setIsPlaying(false);
        },
      });
      playerRef.current = player;
      // Start at initial state
      const initial = player.jumpTo(0, () => createLiveSimulationState());
      setReplayState(initial);
      setProgressRatio(0);
    }
  }, [activeReplayEvents]);

  // Sync speed changes to player
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.setSpeed(replaySpeed);
    }
  }, [replaySpeed]);

  const togglePlay = () => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.pause();
      setIsPlaying(false);
    } else {
      playerRef.current.play(replayState);
      setIsPlaying(true);
    }
  };

  const handleReset = () => {
    if (!playerRef.current) return;
    const clean = playerRef.current.jumpTo(0, () => createLiveSimulationState());
    setReplayState(clean);
    setIsPlaying(false);
    setProgressRatio(0);
  };

  const handleSeek = (ratio: number) => {
    if (!playerRef.current) return;
    const nextState = playerRef.current.seekRatio(ratio, () => createLiveSimulationState());
    setReplayState(nextState);
    setProgressRatio(ratio);
  };

  const handleExportVideo = async () => {
    if (!activeReplayEvents || activeReplayEvents.length === 0) return;
    const canvas = canvasContainerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    try {
      setIsRecording(true);
      setRecordingProgress(0);
      const blob = await recordReplay({
        canvas,
        events: activeReplayEvents,
        speed: replaySpeed,
        fps: 30,
        showUsage,
        title: 'Agent Viewer Run',
        theme,
        onProgress: (p) => setRecordingProgress(Math.round(p * 100)),
      });

      if (onVideoExport) {
        onVideoExport(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `agent-viewer-replay-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      console.error('Video recording failed:', err);
    } finally {
      setIsRecording(false);
    }
  };

  // Drag and drop handler
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setFileError(null);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    try {
      const parsed = await parseEventLog(file);
      if (parsed.events.length === 0) {
        setFileError('File contains 0 valid canonical events');
        return;
      }
      setMode('replay');
      const player = new SessionReplayPlayer(parsed.events, {
        speed: replaySpeed,
        onStep: (_evt, idx, total) => {
          setProgressRatio(total > 0 ? (idx + 1) / total : 0);
        },
        onComplete: () => setIsPlaying(false),
      });
      playerRef.current = player;
      const initial = player.jumpTo(0, () => createLiveSimulationState());
      setReplayState(initial);
      setProgressRatio(0);
    } catch (err: any) {
      setFileError(err?.message || 'Failed to parse event log');
    }
  };

  const currentAgents = mode === 'replay' ? replayState.agents : (propAgents ?? []);
  const activeMeetingId = mode === 'replay' ? replayState.activeMeetingId : propMeetingId;

  const totalTokens = useMemo(() => {
    return currentAgents.reduce(
      (acc, agent) => ({
        input: acc.input + (agent.tokensInput || 0),
        output: acc.output + (agent.tokensOutput || 0),
        cost: acc.cost + (agent.cost || 0),
      }),
      { input: 0, output: 0, cost: 0 },
    );
  }, [currentAgents]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`relative w-full h-full flex flex-col overflow-hidden select-none ${theme} ${className}`}
    >
      {/* Drag & drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-50 bg-slate-950/85 backdrop-blur-sm border-2 border-dashed border-sky-400 flex flex-col items-center justify-center text-sky-200">
          <Upload className="w-12 h-12 mb-3 animate-bounce text-sky-400" />
          <p className="text-lg font-bold">Drop JSONL / OTLP log to Replay</p>
          <p className="text-sm text-slate-400 mt-1">Replay past agent sessions without a server</p>
        </div>
      )}

      {/* Top telemetry & mode pill */}
      {showUsage && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-800 shadow-lg text-xs font-mono">
          <span className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                mode === 'live'
                  ? 'bg-emerald-400 animate-pulse'
                  : mode === 'replay'
                    ? 'bg-violet-400 animate-pulse'
                    : 'bg-amber-400'
              }`}
            />
            <span className="text-slate-300 font-semibold uppercase">{mode}</span>
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Agents:</span>
          <span className="text-slate-100 font-bold">{currentAgents.length}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Tokens:</span>
          <span className="text-cyan-400 font-bold">
            {((totalTokens.input + totalTokens.output) / 1000).toFixed(1)}K
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-emerald-400 font-bold">${totalTokens.cost.toFixed(3)}</span>
        </div>
      )}

      {/* File error toast */}
      {fileError && (
        <div className="absolute top-14 left-3 z-30 flex items-center gap-2 bg-rose-950/90 border border-rose-700 text-rose-200 text-xs px-3 py-2 rounded-lg shadow-xl">
          <AlertCircle className="w-4 h-4 text-rose-400" />
          <span>{fileError}</span>
          <button onClick={() => setFileError(null)} className="ml-2 text-rose-400 hover:text-white font-bold">
            ×
          </button>
        </div>
      )}

      {/* Interactive Office Canvas Container */}
      <div ref={canvasContainerRef} className="flex-1 w-full h-full relative overflow-hidden">
        <OfficeCanvas
          agents={currentAgents}
          selectedAgentId={internalSelectedId}
          onSelectAgent={(id) => {
            setInternalSelectedId(id);
            onSelectAgent?.(id);
          }}
          activeMeetingId={activeMeetingId}
          theme={theme}
          locale={locale}
        />
      </div>

      {/* Bottom Replay Control Bar (Visible in replay mode or when replay events exist) */}
      {(mode === 'replay' || activeReplayEvents.length > 0) && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-slate-900/95 backdrop-blur-md px-4 py-2 rounded-2xl border border-slate-800 shadow-2xl">
          {/* Play / Pause button */}
          <button
            onClick={togglePlay}
            className="p-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-white transition-colors"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>

          {/* Reset button */}
          <button
            onClick={handleReset}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            title="Reset"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          {/* Scrubber slider */}
          <div className="flex items-center gap-2 w-48 sm:w-64">
            <input
              type="range"
              min="0"
              max="1"
              step="0.005"
              value={progressRatio}
              onChange={(e) => handleSeek(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-400"
            />
            <span className="text-[11px] font-mono text-slate-400 tabular-nums">
              {Math.round(progressRatio * 100)}%
            </span>
          </div>

          {/* Speed Selector */}
          <div className="flex items-center gap-1 bg-slate-800/80 p-0.5 rounded-lg border border-slate-700 text-xs font-mono">
            {([1, 2, 4] as const).map((spd) => (
              <button
                key={spd}
                onClick={() => setReplaySpeed(spd)}
                className={`px-2 py-0.5 rounded ${
                  replaySpeed === spd ? 'bg-sky-500 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          {/* Video Export Button */}
          {isRecordingSupported() && (
            <button
              onClick={handleExportVideo}
              disabled={isRecording}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
              title="Export Replay to Video (WebM/MP4)"
            >
              <Video className="w-3.5 h-3.5 text-rose-400" />
              <span>{isRecording ? `${recordingProgress}%` : 'Export Video'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
