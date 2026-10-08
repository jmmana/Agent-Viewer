import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeEventInput } from './officeStore';

export interface EventReplayOptions {
  /** Playback speed multiplier. Defaults to 1. */
  speed?: number;
  /** Start playing as soon as there are events. */
  autoPlay?: boolean;
  /** Longest wait between two events, in event time. Long silences are shortened to this. */
  maxGapMs?: number;
  /** Shortest wait between two events, so bursts stay readable. */
  minGapMs?: number;
}

export interface EventReplay {
  /** The events visible at the current position, ready for `<AgentOffice events>`. */
  events: readonly OfficeEventInput[];
  /** How many events are visible. */
  position: number;
  total: number;
  /** From 0 to 1. */
  progress: number;
  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  /** Jumps to a position between 0 and 1. */
  seek: (ratio: number) => void;
  setSpeed: (speed: number) => void;
}

function timestampOf(event: OfficeEventInput): number {
  const value = (event as { timestamp?: unknown }).timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * Plays a recorded run at its own pace: each event waits the time it waited in the original run, divided by
 * the speed. The hook only reveals events; it never creates any.
 */
export function useEventReplay(source: readonly OfficeEventInput[], options: EventReplayOptions = {}): EventReplay {
  const maxGapMs = options.maxGapMs ?? 5000;
  const minGapMs = options.minGapMs ?? 50;
  const sorted = useMemo(
    () => source.map((event, index) => ({ event, index }))
      .sort((a, b) => timestampOf(a.event) - timestampOf(b.event) || a.index - b.index)
      .map((item) => item.event),
    [source],
  );
  const total = sorted.length;

  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(Boolean(options.autoPlay) && total > 0);
  const [speed, setSpeedState] = useState(options.speed ?? 1);
  const previousSource = useRef(sorted);

  // A different run starts again from the beginning.
  useEffect(() => {
    if (previousSource.current !== sorted) {
      previousSource.current = sorted;
      setPosition(0);
      setPlaying(Boolean(options.autoPlay) && sorted.length > 0);
    }
  }, [sorted, options.autoPlay]);

  useEffect(() => {
    if (!playing) return;
    if (position >= total) {
      setPlaying(false);
      return;
    }
    const gap = position === 0 ? 0 : timestampOf(sorted[position]) - timestampOf(sorted[position - 1]);
    const delay = position === 0 ? 0 : Math.min(maxGapMs, Math.max(minGapMs, gap)) / Math.max(speed, 0.01);
    const timer = setTimeout(() => setPosition((value) => Math.min(total, value + 1)), delay);
    return () => clearTimeout(timer);
  }, [playing, position, total, sorted, speed, maxGapMs, minGapMs]);

  const play = useCallback(() => {
    if (total === 0) return;
    setPosition((value) => (value >= total ? 0 : value));
    setPlaying(true);
  }, [total]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => {
    if (playing) setPlaying(false);
    else play();
  }, [playing, play]);
  const reset = useCallback(() => {
    setPlaying(false);
    setPosition(0);
  }, []);
  const seek = useCallback((ratio: number) => {
    const bounded = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    setPosition(Math.round(bounded * total));
  }, [total]);
  const setSpeed = useCallback((value: number) => {
    if (Number.isFinite(value) && value > 0) setSpeedState(value);
  }, []);

  const events = useMemo(() => sorted.slice(0, position), [sorted, position]);

  return {
    events,
    position,
    total,
    progress: total > 0 ? position / total : 0,
    playing,
    speed,
    play,
    pause,
    toggle,
    reset,
    seek,
    setSpeed,
  };
}
