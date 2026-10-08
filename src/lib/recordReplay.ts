import type { CanonicalEvent } from '../integrations/canonicalContract';
import { createLiveSimulationState, type SimulationState } from '../engine/simulationEngine';
import { applyExternalEvent } from '../integrations/eventIngestion';
import { renderOfficeScene, type CameraState } from '../engine/canvasRenderer';

export interface RecordReplayOptions {
  canvas?: HTMLCanvasElement;
  events: CanonicalEvent[];
  speed?: number; // 1, 2, 4
  fps?: number; // default 30
  width?: number; // default 1280
  height?: number; // default 720
  showUsage?: boolean; // default true
  title?: string;
  theme?: 'dark' | 'light';
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

/**
 * Records an offscreen or provided canvas replay into a video Blob.
 * Uses canvas.captureStream() and MediaRecorder.
 */
export async function recordReplay(options: RecordReplayOptions): Promise<Blob> {
  if (!isRecordingSupported()) {
    throw new Error('Video recording is not supported in this browser environment');
  }

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    throw new Error('No supported video recording MIME type available in MediaRecorder');
  }

  const width = options.width || 1280;
  const height = options.height || 720;
  const fps = options.fps || 30;
  const speed = options.speed || 1;
  const showUsage = options.showUsage ?? true;
  const title = options.title || 'Agent Viewer Run';
  const theme = options.theme || 'dark';

  // Use provided canvas or instantiate an offscreen recording canvas
  let recordCanvas: HTMLCanvasElement;
  if (options.canvas) {
    recordCanvas = options.canvas;
  } else {
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = width;
    recordCanvas.height = height;
  }

  const stream = (recordCanvas as any).captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  return new Promise<Blob>((resolve, reject) => {
    let aborted = false;

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
        reject(new DOMException('Video recording was aborted', 'AbortError'));
      });
    }

    recorder.onerror = (err) => {
      reject(err);
    };

    recorder.onstop = () => {
      if (aborted) return;
      const finalBlob = new Blob(chunks, { type: mimeType });
      options.onProgress?.(1.0);
      resolve(finalBlob);
    };

    recorder.start(100);

    const sortedEvents = [...options.events].sort((a, b) => a.timestamp - b.timestamp);
    const simState: SimulationState = createLiveSimulationState();
    let currentEventIdx = 0;
    const totalEvents = sortedEvents.length;

    const camera: CameraState = {
      x: 0,
      y: 0,
      zoom: 0.9,
      rotation: 0,
    };

    const startTime = Date.now();
    const frameIntervalMs = 1000 / fps;
    let framesRendered = 0;
    const totalEstimatedFrames = Math.max(fps * 2, Math.min(fps * 60, totalEvents * 10));

    const renderInterval = setInterval(() => {
      if (aborted) {
        clearInterval(renderInterval);
        return;
      }

      const now = Date.now();

      // Advance events
      const eventsPerFrame = Math.max(1, Math.round(speed));
      for (let i = 0; i < eventsPerFrame && currentEventIdx < totalEvents; i++) {
        applyExternalEvent(simState, sortedEvents[currentEventIdx]);
        currentEventIdx++;
      }

      // Render frame
      renderOfficeScene({
        canvas: recordCanvas,
        agents: simState.agents,
        selectedAgentId: null,
        hoveredAgentId: null,
        activeMeetingId: simState.activeMeetingId,
        camera,
        theme,
        timeMs: now,
        nowMs: now,
      });

      // Watermark & run timestamp overlay
      const ctx = recordCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(16, 16, 320, showUsage ? 76 : 48);
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(16, 16, 320, showUsage ? 76 : 48);

        ctx.font = '700 13px system-ui, sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(title, 26, 36);

        ctx.font = '500 10px monospace';
        ctx.fillStyle = '#94a3b8';
        const eventTs = currentEventIdx > 0 ? sortedEvents[currentEventIdx - 1]?.timestamp : startTime;
        ctx.fillText(`Timestamp: ${new Date(eventTs).toISOString()}`, 26, 52);

        if (showUsage) {
          ctx.fillStyle = '#38bdf8';
          const tokens = simState.totalTokens.input + simState.totalTokens.output;
          ctx.fillText(`Tokens: ${(tokens / 1000).toFixed(1)}k  |  Cost: $${simState.totalCost.toFixed(3)}`, 26, 74);
        }
        ctx.restore();
      }

      framesRendered++;
      const progressRatio = totalEvents > 0 ? currentEventIdx / totalEvents : framesRendered / totalEstimatedFrames;
      options.onProgress?.(Math.min(0.99, progressRatio));

      // End of replay
      if (currentEventIdx >= totalEvents || framesRendered >= totalEstimatedFrames) {
        clearInterval(renderInterval);
        setTimeout(() => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        }, 300);
      }
    }, frameIntervalMs);
  });
}
