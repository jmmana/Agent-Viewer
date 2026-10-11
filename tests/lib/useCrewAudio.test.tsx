import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrewAudio } from '../../src/crew/useCrewAudio';

/**
 * jsdom no implementa Web Audio API: se sustituye `window.AudioContext` por una
 * versión mínima que registra cada oscilador creado, para poder comprobar desde
 * la prueba si el motor realmente arrancó o detuvo el sonido (mock de audio).
 */
class FakeAudioParam {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void { /* no-op en la prueba */ }
}
class FakeAudioNode {
  disconnected = false;
  connect(): void { /* no-op en la prueba */ }
  disconnect(): void { this.disconnected = true; }
}
class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}
/**
 * Un `AudioContext` real nunca detiene un oscilador en el instante en que se llama
 * `.stop(when)`: solo lo PROGRAMA para el reloj de audio `when`. Este doble
 * reproduce esa semántica con un reloj simulado (`clock`), para no confundir "ya
 * se programó su silencio" con "ya está silenciado ahora".
 */
let clock = 0;
function advanceClock(seconds: number): void { clock += seconds; }

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  started = false;
  private stopAt: number | null = null;
  start(): void { this.started = true; }
  stop(when?: number): void { this.stopAt = when ?? clock; }
  get stopped(): boolean { return this.stopAt !== null && this.stopAt <= clock; }
}

let createdOscillators: FakeOscillatorNode[] = [];

class FakeAudioContext {
  get currentTime(): number { return clock; }
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = new FakeAudioNode();
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createOscillator(): FakeOscillatorNode { const node = new FakeOscillatorNode(); createdOscillators.push(node); return node; }
  resume(): Promise<void> { return Promise.resolve(); }
  suspend(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

function Harness({ roomId, muted, volume }: { roomId: string; muted: boolean; volume: number }) {
  const audio = useCrewAudio({ roomId, muted, volume });
  return (
    <div>
      {/* Botón nativo: operable por teclado (Enter/Espacio) por especificación, sin JS adicional. */}
      <button type="button" onClick={() => audio.play()}>play</button>
      <button type="button" onClick={() => audio.pause()}>pause</button>
      <span data-testid="state">{audio.state}</span>
    </div>
  );
}

describe('useCrewAudio (#150): ciclo de vida React del motor de audio de Crew', () => {
  beforeEach(() => {
    createdOscillators = [];
    clock = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no reproduce nada hasta un clic explícito en Play (nunca autoplay), y el botón nativo activa el motor', async () => {
    render(<Harness roomId="lounge" muted={false} volume={0.6} />);
    expect(createdOscillators).toHaveLength(0);
    expect(screen.getByTestId('state').textContent).toBe('idle');

    await act(async () => { fireEvent.click(screen.getByText('play')); });

    expect(screen.getByTestId('state').textContent).toBe('playing');
    expect(createdOscillators.some(osc => osc.started && !osc.stopped)).toBe(true);
  });

  it('perder el foco de la ventana pausa el audio activo; recuperarlo lo retoma sin requerir un nuevo clic', async () => {
    render(<Harness roomId="lounge" muted={false} volume={0.6} />);
    await act(async () => { fireEvent.click(screen.getByText('play')); });
    expect(createdOscillators.some(osc => !osc.stopped)).toBe(true);

    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(createdOscillators.every(osc => osc.stopped)).toBe(true);

    const stoppedBeforeFocus = createdOscillators.length;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(createdOscillators.length).toBeGreaterThan(stoppedBeforeFocus);
    expect(createdOscillators.some(osc => !osc.stopped)).toBe(true);
  });

  it('ocultar la pestaña (visibilitychange) pausa igual que perder el foco de la ventana', async () => {
    render(<Harness roomId="lounge" muted={false} volume={0.6} />);
    await act(async () => { fireEvent.click(screen.getByText('play')); });

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(createdOscillators.every(osc => osc.stopped)).toBe(true);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(createdOscillators.some(osc => !osc.stopped)).toBe(true);
  });

  it('entrar a una sala sin pista (Desarrollo) detiene el audio de la sala de descanso; volver a ella exige un nuevo clic en Play', async () => {
    const { rerender } = render(<Harness roomId="lounge" muted={false} volume={0.6} />);
    await act(async () => { fireEvent.click(screen.getByText('play')); });
    expect(screen.getByTestId('state').textContent).toBe('playing');

    rerender(<Harness roomId="development" muted={false} volume={0.6} />);
    expect(screen.getByTestId('state').textContent).toBe('paused');
    advanceClock(1); // más allá del fade de salida: confirma que el silencio programado sí llega
    expect(createdOscillators.every(osc => osc.stopped)).toBe(true);

    rerender(<Harness roomId="lounge" muted={false} volume={0.6} />);
    expect(screen.getByTestId('state').textContent).toBe('paused');
    const countBeforeNewPlay = createdOscillators.length;

    await act(async () => { fireEvent.click(screen.getByText('play')); });
    expect(screen.getByTestId('state').textContent).toBe('playing');
    expect(createdOscillators.length).toBeGreaterThan(countBeforeNewPlay);
  });

  it('desmontar el componente limpia los manejadores de foco/visibilidad (sin fugas de listeners)', async () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<Harness roomId="lounge" muted={false} volume={0.6} />);
    await act(async () => { fireEvent.click(screen.getByText('play')); });

    unmount();

    expect(removeWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(createdOscillators.every(osc => osc.stopped)).toBe(true);
  });
});
