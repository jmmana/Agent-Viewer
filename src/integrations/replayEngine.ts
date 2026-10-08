/**
 * Replay Engine for Agent Viewer
 *
 * Supports replaying past sessions or historical events by timestamp or step-by-step
 * without modifying UI components.
 */

import type { CanonicalEvent } from './canonicalContract';
import type { SimulationState } from '../engine/simulationEngine';
import { applyExternalEvent } from './eventIngestion';

export type ViewerMode = 'LIVE' | 'DEMO' | 'REPLAY';

export interface ReplayOptions {
  speed?: number; // 1 = real time, 2 = 2x, etc.
  onStep?: (event: CanonicalEvent, index: number, total: number) => void;
  onComplete?: () => void;
}

export class SessionReplayPlayer {
  private events: CanonicalEvent[] = [];
  private currentIndex = 0;
  private isPlaying = false;
  private speed = 1;
  private timer: any = null;
  private onStep?: (event: CanonicalEvent, index: number, total: number) => void;
  private onComplete?: () => void;

  constructor(events: CanonicalEvent[], options: ReplayOptions = {}) {
    // Sort chronologically ascending
    this.events = [...events].sort((a, b) => a.timestamp - b.timestamp);
    this.speed = options.speed ?? 1;
    this.onStep = options.onStep;
    this.onComplete = options.onComplete;
  }

  get totalEvents(): number {
    return this.events.length;
  }

  get currentEventIndex(): number {
    return this.currentIndex;
  }

  get active(): boolean {
    return this.isPlaying;
  }

  setSpeed(multiplier: number): void {
    this.speed = Math.max(0.25, Math.min(10, multiplier));
  }

  get progressRatio(): number {
    if (this.events.length === 0) return 0;
    return Math.min(1, this.currentIndex / this.events.length);
  }

  get currentTimestamp(): number | null {
    if (this.events.length === 0) return null;
    const index = Math.max(0, Math.min(this.events.length - 1, this.currentIndex - 1));
    return this.events[index]?.timestamp ?? null;
  }

  jumpTo(targetIndex: number, createCleanStateFn: () => SimulationState): SimulationState {
    const wasPlaying = this.isPlaying;
    this.pause();

    const bounded = Math.max(0, Math.min(this.events.length, targetIndex));
    const nextState = createCleanStateFn();

    for (let i = 0; i < bounded; i++) {
      applyExternalEvent(nextState, this.events[i]);
    }

    this.currentIndex = bounded;
    if (bounded > 0) {
      this.onStep?.(this.events[bounded - 1], bounded - 1, this.events.length);
    }

    if (wasPlaying && bounded < this.events.length) {
      this.play(nextState);
    }

    return nextState;
  }

  seekRatio(ratio: number, createCleanStateFn: () => SimulationState): SimulationState {
    const target = Math.round(ratio * this.events.length);
    return this.jumpTo(target, createCleanStateFn);
  }

  step(state: SimulationState): boolean {
    if (this.currentIndex >= this.events.length) {
      this.pause();
      this.onComplete?.();
      return false;
    }

    const event = this.events[this.currentIndex];
    applyExternalEvent(state, event);
    this.onStep?.(event, this.currentIndex, this.events.length);
    this.currentIndex++;
    return true;
  }

  play(state: SimulationState): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.scheduleNext(state);
  }

  pause(): void {
    this.isPlaying = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.pause();
    this.currentIndex = 0;
  }

  private scheduleNext(state: SimulationState): void {
    if (!this.isPlaying) return;
    if (this.currentIndex >= this.events.length) {
      this.isPlaying = false;
      this.onComplete?.();
      return;
    }

    const currentEvent = this.events[this.currentIndex];
    const nextEvent = this.events[this.currentIndex + 1];

    let delayMs = 1000;
    if (nextEvent) {
      const diff = Math.max(50, nextEvent.timestamp - currentEvent.timestamp);
      // Cap max inter-event wait time in replay to 5000ms
      delayMs = Math.min(5000, diff) / this.speed;
    }

    this.timer = setTimeout(() => {
      if (this.step(state)) {
        this.scheduleNext(state);
      }
    }, delayMs);
  }
}
