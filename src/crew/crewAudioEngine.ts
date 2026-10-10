import { CREW_ROOM_MUSIC, type CrewAudioCueId, type CrewAudioTrackId } from './crewAudioAssets';

/**
 * Motor de audio propio de Crew (#150). Independiente del motor de Caricatura
 * (`src/engine/soundEffects.ts`): no comparte estado, preferencia ni AudioContext.
 *
 * Reglas duras que este archivo existe para cumplir:
 * - Nunca reproduce nada por sí solo. `play()` solo debe llamarse desde un manejador
 *   de un gesto explícito del usuario (clic en Play, tecla Enter/Espacio sobre el
 *   botón); el motor jamás se autoinicia al construirse, al cambiar de sala ni al
 *   volver a enfocar la ventana.
 * - Cada sala tiene su propia pista (o silencio) vía `CREW_ROOM_MUSIC`: cambiar de
 *   sala jamás deja sonando la pista de la sala anterior, y volver a una sala con
 *   música exige un nuevo gesto del usuario, no la reanuda sola.
 * - `dispose()` detiene todo osciladores, los desconecta y suelta el AudioContext:
 *   no debe quedar ningún nodo ni temporizador vivo tras desmontar.
 *
 * Las interfaces `CrewAudio*` describen solo el subconjunto de la Web Audio API que
 * el motor usa, para poder inyectar una implementación de prueba sin DOM real
 * (jsdom no implementa Web Audio). Un `AudioContext` real del navegador cumple esta
 * interfaz de forma estructural, sin necesidad de convertir tipos.
 */

export interface CrewAudioParam {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  cancelScheduledValues(time: number): void;
}

export interface CrewAudioNode {
  connect(destination: CrewAudioNode): void;
  disconnect(): void;
}

export interface CrewGainNode extends CrewAudioNode {
  gain: CrewAudioParam;
}

export interface CrewOscillatorNode extends CrewAudioNode {
  type: OscillatorType;
  frequency: CrewAudioParam;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface CrewAudioContextLike {
  readonly currentTime: number;
  /** No se usa en la lógica del motor; se conserva solo para que un `AudioContext` real cumpla esta interfaz sin conversión. */
  readonly state: AudioContextState;
  readonly destination: CrewAudioNode;
  createGain(): CrewGainNode;
  createOscillator(): CrewOscillatorNode;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export type CrewAudioState = 'idle' | 'playing' | 'paused' | 'blocked' | 'unsupported';

const FADE_SECONDS = 0.6;
/** Arpegio de cuatro notas (acorde Am7 suave) repetido cada ciclo: la "playlist" de la sala de descanso. */
const LOUNGE_NOTES_HZ = [220, 261.63, 329.63, 392];
const LOUNGE_NOTE_SECONDS = 0.9;
const LOUNGE_LOOP_SECONDS = LOUNGE_NOTES_HZ.length * LOUNGE_NOTE_SECONDS;

function defaultCreateContext(): CrewAudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor();
}

export interface CrewAudioEngineOptions {
  muted: boolean;
  volume: number;
  roomId: string;
  /** Inyectable para pruebas; por defecto crea un `AudioContext` real del navegador. */
  createContext?: () => CrewAudioContextLike | null;
  onStateChange?: (state: CrewAudioState) => void;
}

interface ActiveTrack {
  id: CrewAudioTrackId;
  gain: CrewGainNode;
  oscillators: CrewOscillatorNode[];
  loopTimer: ReturnType<typeof setTimeout> | null;
  /** Temporizadores que desconectan la ganancia de cada nota una vez terminada; se cancelan junto con `loopTimer`. */
  cleanupTimers: ReturnType<typeof setTimeout>[];
}

export class CrewAudioEngine {
  private ctx: CrewAudioContextLike | null = null;
  private master: CrewGainNode | null = null;
  private active: ActiveTrack | null = null;
  private muted: boolean;
  private volume: number;
  private roomId: string;
  /** Verdadero solo entre un `play()` exitoso y el siguiente `pause()`/cambio de sala sin música. */
  private wantsPlaying = false;
  private wasPlayingBeforeSuspend = false;
  private _disposed = false;
  private readonly createContext: () => CrewAudioContextLike | null;
  private readonly onStateChange?: (state: CrewAudioState) => void;
  private _state: CrewAudioState = 'idle';

  constructor(options: CrewAudioEngineOptions) {
    this.muted = options.muted;
    this.volume = options.volume;
    this.roomId = options.roomId;
    this.createContext = options.createContext ?? defaultCreateContext;
    this.onStateChange = options.onStateChange;
  }

  get state(): CrewAudioState {
    return this._state;
  }

  /** Verdadero cuando la sala activa tiene una pista configurada en `CREW_ROOM_MUSIC`. */
  get roomHasTrack(): boolean {
    return CREW_ROOM_MUSIC[this.roomId] != null;
  }

  /** Verdadero tras `dispose()`. Público para que un host (por ejemplo `useCrewAudio` bajo
   * el doble efecto de React StrictMode) sepa que debe crear una instancia nueva en vez de
   * reutilizar esta. */
  get disposed(): boolean {
    return this._disposed;
  }

  private setState(next: CrewAudioState): void {
    if (this._state === next) return;
    this._state = next;
    this.onStateChange?.(next);
  }

  private ensureContext(): CrewAudioContextLike | null {
    if (this._disposed) return null;
    if (this.ctx) return this.ctx;
    const ctx = this.createContext();
    if (!ctx) {
      this.setState('unsupported');
      return null;
    }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.setValueAtTime(this.muted ? 0 : this.volume, ctx.currentTime);
    master.connect(ctx.destination);
    this.master = master;
    return ctx;
  }

  /**
   * Inicia (o reanuda) el audio de la sala activa. Debe llamarse solo desde un
   * manejador de gesto explícito del usuario: nunca desde un efecto de montaje ni
   * desde `setRoom`/`resumeFromSuspend`.
   */
  play(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    const ctx = this.ensureContext();
    if (!ctx) return Promise.resolve();
    this.wantsPlaying = true;
    return ctx
      .resume()
      .then(() => {
        if (this._disposed || !this.wantsPlaying) return;
        if (this.roomHasTrack) {
          this.startActiveTrack();
          this.setState('playing');
        } else {
          this.setState('idle');
        }
      })
      .catch(() => {
        // Política de autoplay del navegador: la reproducción quedó bloqueada hasta un
        // nuevo gesto. No reintenta solo; el llamador decide si muestra un aviso.
        this.wantsPlaying = false;
        this.setState('blocked');
      });
  }

  pause(): void {
    if (this._disposed) return;
    this.wantsPlaying = false;
    this.stopActiveTrack({ fade: true });
    if (this._state !== 'unsupported') this.setState('paused');
  }

  setPreferences(muted: boolean, volume: number): void {
    this.muted = muted;
    this.volume = volume;
    if (this.ctx && this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.muted ? 0 : this.volume, now);
    }
  }

  /**
   * Cambia la sala activa. Nunca autoinicia audio: si la sala nueva no tiene pista,
   * detiene con fade y exige un nuevo `play()` (ni siquiera recuerda que sonaba);
   * si la tiene y ya estaba sonando, hace crossfade a la nueva pista sin requerir
   * un nuevo gesto (la reproducción ya estaba autorizada).
   */
  setRoom(roomId: string): void {
    if (this._disposed || this.roomId === roomId) return;
    this.roomId = roomId;
    if (!this.wantsPlaying) return;
    this.stopActiveTrack({ fade: true });
    if (this.roomHasTrack) {
      this.startActiveTrack();
      this.setState('playing');
    } else {
      this.wantsPlaying = false;
      this.setState('paused');
    }
  }

  /** Pérdida de foco de la ventana/pestaña: pausa sin perder la intención de reanudar. */
  suspendForFocusLoss(): void {
    if (this._disposed) return;
    this.wasPlayingBeforeSuspend = this.wantsPlaying && this._state === 'playing';
    if (this.wasPlayingBeforeSuspend) this.stopActiveTrack({ fade: false });
  }

  /** Recupera el foco: reanuda solo si ya sonaba antes de perder el foco (no es autoplay nuevo). */
  resumeFromFocus(): void {
    if (this._disposed || !this.wasPlayingBeforeSuspend) return;
    this.wasPlayingBeforeSuspend = false;
    if (this.wantsPlaying && this.roomHasTrack) {
      this.startActiveTrack();
      this.setState('playing');
    }
  }

  /**
   * Efecto corto de un disparo (aviso/notificación), independiente de la música de fondo.
   * `id` elige el patrón sintetizado del manifiesto (`CREW_AUDIO_MANIFEST`); por defecto,
   * el aviso genérico de `ui-notification` (#150). Sigue respetando mute igual que siempre.
   */
  playCue(id: CrewAudioCueId = 'ui-notification'): void {
    if (this._disposed || this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    if (id === 'phone-ring') {
      this.playPhoneRingCue(ctx, this.master);
      return;
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.3);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.32);
    setTimeout(() => gain.disconnect(), 340);
  }

  /** Timbre de teléfono (#145): dos ráfagas de tonos distintos, patrón de timbre de dos golpes. */
  private playPhoneRingCue(ctx: CrewAudioContextLike, master: CrewGainNode): void {
    const base = ctx.currentTime;
    const burst = (offsetSeconds: number, frequency: number) => {
      const start = base + offsetSeconds;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.45, start + 0.03);
      gain.gain.linearRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.24);
      setTimeout(() => gain.disconnect(), offsetSeconds * 1000 + 260);
    };
    burst(0, 480);
    burst(0.28, 620);
  }

  private startActiveTrack(): void {
    const ctx = this.ctx;
    const master = this.master;
    const trackId = CREW_ROOM_MUSIC[this.roomId];
    if (!ctx || !master || !trackId) return;
    this.stopActiveTrack({ fade: false });
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
    gain.connect(master);
    const track: ActiveTrack = { id: trackId, gain, oscillators: [], loopTimer: null, cleanupTimers: [] };
    this.active = track;
    this.scheduleLoungeLoop(track);
  }

  private scheduleLoungeLoop(track: ActiveTrack): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const start = ctx.currentTime;
    LOUNGE_NOTES_HZ.forEach((frequency, index) => {
      const noteStart = start + index * LOUNGE_NOTE_SECONDS;
      const osc = ctx.createOscillator();
      const noteGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, noteStart);
      noteGain.gain.setValueAtTime(0.0001, noteStart);
      noteGain.gain.linearRampToValueAtTime(0.18, noteStart + 0.08);
      noteGain.gain.linearRampToValueAtTime(0.0001, noteStart + LOUNGE_NOTE_SECONDS * 0.95);
      osc.connect(noteGain);
      noteGain.connect(track.gain);
      osc.start(noteStart);
      osc.stop(noteStart + LOUNGE_NOTE_SECONDS);
      track.cleanupTimers.push(setTimeout(() => noteGain.disconnect(), (index + 1) * LOUNGE_NOTE_SECONDS * 1000 + 20));
      track.oscillators.push(osc);
    });
    track.loopTimer = setTimeout(() => {
      if (this.active !== track) return;
      track.oscillators = [];
      track.cleanupTimers = [];
      this.scheduleLoungeLoop(track);
    }, LOUNGE_LOOP_SECONDS * 1000);
  }

  private stopActiveTrack(options: { fade: boolean }): void {
    const ctx = this.ctx;
    const track = this.active;
    this.active = null;
    if (!track) return;
    if (track.loopTimer != null) clearTimeout(track.loopTimer);
    for (const timer of track.cleanupTimers) clearTimeout(timer);
    if (ctx && options.fade) {
      const now = ctx.currentTime;
      track.gain.gain.cancelScheduledValues(now);
      track.gain.gain.setValueAtTime(track.gain.gain.value, now);
      track.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    }
    const stopAt = ctx && options.fade ? ctx.currentTime + FADE_SECONDS : ctx?.currentTime ?? 0;
    for (const osc of track.oscillators) {
      try { osc.stop(stopAt); } catch { /* ya pudo haber terminado solo */ }
    }
    const cleanupDelay = options.fade ? FADE_SECONDS * 1000 + 50 : 0;
    setTimeout(() => track.gain.disconnect(), cleanupDelay);
  }

  /** Detiene todo, desconecta nodos y suelta el AudioContext. Idempotente. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.wantsPlaying = false;
    this.stopActiveTrack({ fade: false });
    this.master?.disconnect();
    this.master = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
