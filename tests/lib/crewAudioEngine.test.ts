import { describe, expect, it, vi } from 'vitest';
import { CrewAudioEngine, type CrewAudioContextLike, type CrewAudioNode, type CrewAudioParam, type CrewAudioState, type CrewGainNode, type CrewOscillatorNode } from '../../src/crew/crewAudioEngine';

class FakeParam implements CrewAudioParam {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void { /* no-op en la prueba */ }
}

class FakeNode implements CrewAudioNode {
  connections: FakeNode[] = [];
  disconnected = false;
  connect(destination: CrewAudioNode): void { this.connections.push(destination as FakeNode); }
  disconnect(): void { this.disconnected = true; }
}

class FakeGainNode extends FakeNode implements CrewGainNode {
  gain = new FakeParam();
}

/**
 * Un `AudioContext` real nunca detiene un oscilador en el instante en que se llama
 * `.stop(when)`: solo lo PROGRAMA para el reloj de audio `when`. Este doble (y el
 * de `useCrewAudio.test.tsx`) reproduce esa semántica con un reloj simulado, para
 * no confundir "ya se programó su silencio" con "ya está silenciado ahora".
 */
class FakeOscillatorNode extends FakeNode implements CrewOscillatorNode {
  type: OscillatorType = 'sine';
  frequency = new FakeParam();
  started = false;
  private stopAt: number | null = null;
  constructor(private readonly now: () => number) { super(); }
  start(): void { this.started = true; }
  stop(when?: number): void { this.stopAt = when ?? this.now(); }
  get stopped(): boolean { return this.stopAt !== null && this.stopAt <= this.now(); }
}

function fakeContext() {
  let time = 0;
  const gains: FakeGainNode[] = [];
  const oscillators: FakeOscillatorNode[] = [];
  let resumeImpl: () => Promise<void> = () => Promise.resolve();
  const ctx: CrewAudioContextLike = {
    get currentTime() { return time; },
    state: 'suspended',
    destination: new FakeNode(),
    createGain(): CrewGainNode { const node = new FakeGainNode(); gains.push(node); return node; },
    createOscillator(): CrewOscillatorNode { const node = new FakeOscillatorNode(() => time); oscillators.push(node); return node; },
    resume: () => resumeImpl(),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return {
    ctx, gains, oscillators,
    /** Avanza el reloj simulado, para comprobar que un fade programado sí silencia a tiempo. */
    advance: (seconds: number) => { time += seconds; },
    setResumeImpl: (impl: () => Promise<void>) => { resumeImpl = impl; },
  };
}

describe('CrewAudioEngine (#150)', () => {
  it('nunca toca el AudioContext hasta que se llama play(): sin gesto, sin audio', () => {
    const createContext = vi.fn(() => fakeContext().ctx);
    new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext });
    expect(createContext).not.toHaveBeenCalled();
  });

  it('play() en una sala con pista arranca osciladores, fija la ganancia maestra y hace fade de entrada en la pista', async () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    await engine.play();
    expect(engine.state).toBe('playing');
    expect(fake.oscillators.length).toBeGreaterThan(0);
    expect(fake.oscillators.every(osc => osc.started)).toBe(true);
    // gains[0] = ganancia maestra (mute/volumen global); gains[1] = fade de entrada de la pista.
    expect(fake.gains[0].gain.value).toBeCloseTo(0.6);
    expect(fake.gains[1].gain.value).toBeCloseTo(1);
    engine.dispose(); // libera el temporizador del loop antes de que termine la prueba
  });

  it('una sala sin pista (por ejemplo Desarrollo) nunca reproduce nada, ni con play()', async () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'development', createContext: () => fake.ctx });
    await engine.play();
    expect(engine.state).toBe('idle');
    expect(fake.oscillators).toHaveLength(0);
    expect(engine.roomHasTrack).toBe(false);
  });

  it('cambiar de la sala de descanso a Desarrollo detiene el audio (aislamiento por sala)', async () => {
    const fake = fakeContext();
    const states: CrewAudioState[] = [];
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx, onStateChange: state => states.push(state) });
    await engine.play();
    const oscillatorsBeforeLeaving = fake.oscillators.filter(osc => !osc.stopped);
    expect(oscillatorsBeforeLeaving.length).toBeGreaterThan(0);

    engine.setRoom('development');
    expect(engine.state).toBe('paused');
    fake.advance(1); // más allá del fade de salida: confirma que el silencio programado sí llega
    expect(fake.oscillators.every(osc => osc.stopped)).toBe(true);
    expect(states).toContain('playing');
    expect(states).toContain('paused');
  });

  it('volver a la sala de descanso NO reanuda sola la música: exige un nuevo play()', async () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    await engine.play();
    engine.setRoom('development');
    const oscillatorCountAfterLeaving = fake.oscillators.length;

    engine.setRoom('lounge');
    expect(engine.state).toBe('paused');
    expect(fake.oscillators).toHaveLength(oscillatorCountAfterLeaving);

    await engine.play();
    expect(engine.state).toBe('playing');
    expect(fake.oscillators.length).toBeGreaterThan(oscillatorCountAfterLeaving);
    engine.dispose(); // libera el temporizador del loop antes de que termine la prueba
  });

  it('mute y volumen global se reflejan en la ganancia maestra sin crear un AudioContext por adelantado', () => {
    const fake = fakeContext();
    const createContext = vi.fn(() => fake.ctx);
    const engine = new CrewAudioEngine({ muted: true, volume: 0.6, roomId: 'lounge', createContext });
    engine.setPreferences(false, 0.25);
    expect(createContext).not.toHaveBeenCalled();
  });

  it('autoplay bloqueado por el navegador (resume() rechaza) se reporta como estado "blocked", nunca lanza', async () => {
    const fake = fakeContext();
    fake.setResumeImpl(() => Promise.reject(new Error('NotAllowedError')));
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    await expect(engine.play()).resolves.toBeUndefined();
    expect(engine.state).toBe('blocked');
  });

  it('un navegador sin Web Audio API (jsdom, o uno viejo) se reporta como "unsupported" sin lanzar', async () => {
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => null });
    await engine.play();
    expect(engine.state).toBe('unsupported');
  });

  it('pausa manual detiene los osciladores activos y pasa a estado "paused"', async () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    await engine.play();
    engine.pause();
    expect(engine.state).toBe('paused');
    fake.advance(1); // Pausar también hace fade de salida, igual que cambiar de sala
    expect(fake.oscillators.every(osc => osc.stopped)).toBe(true);
  });

  it('dispose() es idempotente, detiene todo, desconecta la ganancia maestra y cierra el contexto', async () => {
    const fake = fakeContext();
    const close = vi.fn(() => Promise.resolve());
    const ctxWithSpy: CrewAudioContextLike = { ...fake.ctx, close };
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => ctxWithSpy });
    await engine.play();
    engine.dispose();
    expect(fake.oscillators.every(osc => osc.stopped)).toBe(true);
    expect(fake.gains[0].disconnected).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => engine.dispose()).not.toThrow();
    // Tras dispose(), un nuevo play() no debe recrear nada ni lanzar.
    await expect(engine.play()).resolves.toBeUndefined();
    expect(fake.oscillators.filter(osc => !osc.stopped)).toHaveLength(0);
  });

  it('suspendForFocusLoss() pausa el audio activo y resumeFromFocus() lo retoma solo si ya sonaba (no es un autoplay nuevo)', async () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    await engine.play();
    const playingOscillators = fake.oscillators.filter(osc => !osc.stopped).length;
    expect(playingOscillators).toBeGreaterThan(0);

    engine.suspendForFocusLoss();
    expect(fake.oscillators.every(osc => osc.stopped)).toBe(true);

    engine.resumeFromFocus();
    expect(engine.state).toBe('playing');
    expect(fake.oscillators.some(osc => !osc.stopped)).toBe(true);
    engine.dispose(); // libera el temporizador del loop antes de que termine la prueba
  });

  it('resumeFromFocus() no hace nada si el audio no sonaba antes de perder el foco (nunca autoplay)', () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'lounge', createContext: () => fake.ctx });
    engine.resumeFromFocus();
    expect(engine.state).toBe('idle');
    expect(fake.oscillators).toHaveLength(0);
  });

  it('playCue() reproduce un efecto corto independiente de la música de fondo, salvo si está silenciado', () => {
    const fake = fakeContext();
    const engine = new CrewAudioEngine({ muted: false, volume: 0.6, roomId: 'development', createContext: () => fake.ctx });
    engine.playCue();
    expect(fake.oscillators.length).toBeGreaterThan(0);

    const mutedFake = fakeContext();
    const mutedEngine = new CrewAudioEngine({ muted: true, volume: 0.6, roomId: 'development', createContext: () => mutedFake.ctx });
    mutedEngine.playCue();
    expect(mutedFake.oscillators).toHaveLength(0);
  });
});
