import { renderOfficeScene, type CameraState } from '../engine/canvasRenderer';
import { getOfficeRenderedBounds } from '../engine/officeModel';
import { OfficeMotion } from '../engine/visualMotion';
import { createOfficeTranslator, type HostTranslate, type OfficeMessages } from '../content/officeMessages';
import { OfficeStore, type AgentProfile, type OfficeEventInput, type OfficeMode } from './officeStore';
import { formatUsage, type OfficeUsage } from './usage';

export interface RecordReplayOptions {
  events: readonly OfficeEventInput[];
  agents?: readonly AgentProfile[];
  mode?: OfficeMode;
  /** Playback speed multiplier. Defaults to 1. */
  speed?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Longest wait between two events, in event time. Long silences are shortened to this. */
  maxGapMs?: number;
  /** Time the last frame stays on screen after the final event. */
  tailMs?: number;
  /** Hard limit for the video length. */
  maxDurationMs?: number;
  theme?: 'dark' | 'light';
  locale?: string;
  messages?: Partial<OfficeMessages>;
  t?: HostTranslate;
  /** Title drawn in the corner of the video. Nothing is drawn when it is missing. */
  title?: string;
  /** Draw the figures from `usage`. Off by default; the export never computes usage. */
  showUsage?: boolean;
  usage?: OfficeUsage;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export function isRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as any).captureStream === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function getSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
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

export interface ReplaySchedule {
  /** Events in playback order. */
  events: OfficeEventInput[];
  /** Playback time of each event, in milliseconds from the start of the video. */
  offsets: number[];
  /** Total video length, including the tail. */
  durationMs: number;
}

/** When each event appears in the video. Silences longer than `maxGapMs` are shortened. */
export function computeReplaySchedule(
  events: readonly OfficeEventInput[],
  options: { speed?: number; maxGapMs?: number; tailMs?: number; maxDurationMs?: number } = {},
): ReplaySchedule {
  const speed = Math.max(options.speed ?? 1, 0.01);
  const maxGapMs = options.maxGapMs ?? 5000;
  const tailMs = options.tailMs ?? 2000;
  const sorted = events.map((event, index) => ({ event, index }))
    .sort((a, b) => timestampOf(a.event) - timestampOf(b.event) || a.index - b.index)
    .map((item) => item.event);
  const offsets: number[] = [];
  let cursor = 0;
  sorted.forEach((event, index) => {
    if (index > 0) {
      const gap = Math.max(0, timestampOf(event) - timestampOf(sorted[index - 1]));
      cursor += Math.min(gap, maxGapMs) / speed;
    }
    offsets.push(cursor);
  });
  const durationMs = Math.min(cursor + tailMs, options.maxDurationMs ?? 10 * 60 * 1000);
  return { events: sorted, offsets, durationMs };
}

function fitCamera(width: number, height: number): CameraState {
  const bounds = getOfficeRenderedBounds(0);
  const zoom = Math.min((width * 0.96) / bounds.width, (height * 0.96) / bounds.height);
  return { x: -bounds.centerX, y: -bounds.centerY + 24 / zoom, zoom, rotation: 0 };
}

/**
 * Records a replay of `events` into a video Blob with MediaRecorder. The video is drawn on its own
 * offscreen canvas, so the office on the page is not affected.
 */
export async function recordReplay(options: RecordReplayOptions): Promise<Blob> {
  if (!isRecordingSupported()) {
    throw new Error('Video recording is not supported in this browser environment');
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    throw new Error('No supported video recording MIME type available in MediaRecorder');
  }

  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const fps = options.fps ?? 30;
  const theme = options.theme ?? 'dark';
  const translate = createOfficeTranslator({ locale: options.locale, messages: options.messages, t: options.t });
  const schedule = computeReplaySchedule(options.events, options);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is not available');

  const stream = (canvas as any).captureStream(fps) as MediaStream;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const store = new OfficeStore({ mode: options.mode, locale: options.locale });
  const motion = new OfficeMotion();
  const camera = fitCamera(width, height);
  const frameMs = 1000 / fps;
  const usageLines = options.showUsage && options.usage?.total
    ? formatUsage(options.usage.total, options.locale, translate).map((item) => `${item.label}: ${item.value}`)
    : [];

  return new Promise<Blob>((resolve, reject) => {
    let aborted = false;
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (recorder.state !== 'inactive') recorder.stop();
    };

    options.signal?.addEventListener('abort', () => {
      aborted = true;
      stop();
      reject(new DOMException('Video recording was aborted', 'AbortError'));
    });
    recorder.onerror = (error) => {
      stop();
      reject(error);
    };
    recorder.onstop = () => {
      if (aborted) return;
      options.onProgress?.(1);
      resolve(new Blob(chunks, { type: mimeType }));
    };

    recorder.start(100);

    timer = setInterval(() => {
      const playback = frame * frameMs;
      let visible = 0;
      while (visible < schedule.events.length && schedule.offsets[visible] <= playback) visible++;
      store.sync(schedule.events.slice(0, visible), options.agents, playback);
      store.tick(playback);
      const snapshot = store.snapshot();

      renderOfficeScene({
        ctx,
        width,
        height,
        camera,
        agents: motion.update(snapshot.agents, frame === 0 ? 0 : frameMs),
        selectedAgentId: null,
        hoveredAgentId: null,
        activeMeetingId: snapshot.activeMeetingId,
        timeMs: playback,
        nowMs: playback,
        theme,
        translate,
      });

      const overlay = [options.title, ...usageLines].filter((line): line is string => Boolean(line));
      const lastVisible = visible > 0 ? schedule.events[visible - 1] : undefined;
      if (lastVisible) {
        const time = new Date(timestampOf(lastVisible)).toLocaleString(options.locale);
        overlay.push(translate('video.time', { time }));
      }
      if (overlay.length > 0) {
        ctx.save();
        ctx.fillStyle = theme === 'dark' ? 'rgba(15, 23, 42, 0.85)' : 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(16, 16, 360, 16 + overlay.length * 18);
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillStyle = theme === 'dark' ? '#f8fafc' : '#0f172a';
        overlay.forEach((line, index) => ctx.fillText(line, 26, 36 + index * 18));
        ctx.restore();
      }

      frame++;
      options.onProgress?.(Math.min(0.99, playback / Math.max(schedule.durationMs, 1)));
      if (playback >= schedule.durationMs) stop();
    }, frameMs);
  });
}
