import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  ReplayControls,
  useEventReplay,
  type EventReplayOptions,
  type OfficeEventInput,
} from '../../src/lib/index';
import { T0, makeEvent } from './fixtures';

/** Four events with gaps of 1 s, 2 s and 17 s, deliberately out of order. */
const run: OfficeEventInput[] = [
  makeEvent('agent.status.changed', 'ana', { status: 'TESTING' }, { id: 'e3', at: T0 + 3_000 }),
  makeEvent('agent.registered', 'ana', { name: 'Ana Rivas' }, { id: 'e1', at: T0 }),
  makeEvent('agent.status.changed', 'ana', { status: 'DONE' }, { id: 'e4', at: T0 + 20_000 }),
  makeEvent('agent.status.changed', 'ana', { status: 'CODING' }, { id: 'e2', at: T0 + 1_000 }),
];

const visibleIds = (events: readonly OfficeEventInput[]) => events.map((event) => event.id);

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function renderReplay(source: readonly OfficeEventInput[] = run, options?: EventReplayOptions) {
  return renderHook(({ events, opts }) => useEventReplay(events, opts), {
    initialProps: { events: source, opts: options },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEventReplay', () => {
  it('starts paused at the beginning', () => {
    const { result } = renderReplay();
    expect(result.current).toMatchObject({ position: 0, total: 4, progress: 0, playing: false, speed: 1 });
    expect(result.current.events).toEqual([]);
  });

  it('reveals the events in time order, waiting the original gaps', () => {
    const { result } = renderReplay();
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);

    advance(0);
    expect(visibleIds(result.current.events)).toEqual(['e1']);

    advance(999);
    expect(result.current.position).toBe(1);
    advance(1);
    expect(visibleIds(result.current.events)).toEqual(['e1', 'e2']);

    advance(1_999);
    expect(result.current.position).toBe(2);
    advance(1);
    expect(visibleIds(result.current.events)).toEqual(['e1', 'e2', 'e3']);

    // The 17 s silence is shortened to the default 5 s.
    advance(4_999);
    expect(result.current.position).toBe(3);
    advance(1);
    expect(visibleIds(result.current.events)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(result.current.progress).toBe(1);

    // It stops by itself at the end.
    advance(0);
    expect(result.current.playing).toBe(false);
  });

  it('divides the waits by the speed', () => {
    const { result } = renderReplay(run, { speed: 2 });
    act(() => result.current.play());
    advance(0);
    advance(499);
    expect(result.current.position).toBe(1);
    advance(1);
    expect(result.current.position).toBe(2);
    advance(1_000);
    expect(result.current.position).toBe(3);
    advance(2_500);
    expect(result.current.position).toBe(4);
  });

  it('applies a new speed while playing', () => {
    const { result } = renderReplay();
    act(() => result.current.play());
    advance(0);
    act(() => result.current.setSpeed(4));
    expect(result.current.speed).toBe(4);
    advance(250);
    expect(result.current.position).toBe(2);
  });

  it('ignores invalid speeds', () => {
    const { result } = renderReplay();
    for (const value of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      act(() => result.current.setSpeed(value));
    }
    expect(result.current.speed).toBe(1);
  });

  it('shortens silences to maxGapMs', () => {
    const { result } = renderReplay(run, { maxGapMs: 1_500 });
    act(() => result.current.play());
    advance(0);
    advance(1_000);
    advance(1_500);
    expect(result.current.position).toBe(3);
    advance(1_499);
    expect(result.current.position).toBe(3);
    advance(1);
    expect(result.current.position).toBe(4);
  });

  it('waits at least minGapMs between events with the same time', () => {
    const burst = [
      makeEvent('agent.status.changed', 'ana', { status: 'CODING' }, { id: 'b1', at: T0 }),
      makeEvent('agent.status.changed', 'ana', { status: 'TESTING' }, { id: 'b2', at: T0 }),
    ];
    const { result } = renderReplay(burst, { minGapMs: 200 });
    act(() => result.current.play());
    advance(0);
    advance(199);
    expect(result.current.position).toBe(1);
    advance(1);
    expect(result.current.position).toBe(2);
  });

  it('seeks to a ratio of the run', () => {
    const { result } = renderReplay();
    act(() => result.current.seek(0.5));
    expect(visibleIds(result.current.events)).toEqual(['e1', 'e2']);
    expect(result.current.progress).toBe(0.5);

    act(() => result.current.seek(1));
    expect(result.current.position).toBe(4);
    act(() => result.current.seek(7));
    expect(result.current.position).toBe(4);
    act(() => result.current.seek(-1));
    expect(result.current.position).toBe(0);
    act(() => result.current.seek(Number.NaN));
    expect(result.current.position).toBe(0);
  });

  it('resets to the start and pauses', () => {
    const { result } = renderReplay();
    act(() => result.current.play());
    advance(0);
    advance(1_000);
    expect(result.current.position).toBe(2);

    act(() => result.current.reset());
    expect(result.current).toMatchObject({ position: 0, playing: false, progress: 0 });
    expect(result.current.events).toEqual([]);
    advance(10_000);
    expect(result.current.position).toBe(0);
  });

  it('pauses and resumes with toggle', () => {
    const { result } = renderReplay();
    act(() => result.current.toggle());
    advance(0);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
    advance(10_000);
    expect(result.current.position).toBe(1);
    act(() => result.current.toggle());
    advance(1_000);
    expect(result.current.position).toBe(2);
  });

  it('plays again from the start after the end', () => {
    const { result } = renderReplay();
    act(() => result.current.seek(1));
    act(() => result.current.play());
    expect(result.current.position).toBe(0);
    expect(result.current.playing).toBe(true);
  });

  it('starts by itself with autoPlay', () => {
    const { result } = renderReplay(run, { autoPlay: true });
    expect(result.current.playing).toBe(true);
    advance(0);
    expect(result.current.position).toBe(1);
  });

  it('does not play an empty run', () => {
    const { result } = renderReplay([]);
    act(() => result.current.play());
    expect(result.current.playing).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  it('starts again when the host passes a different run', () => {
    const { result, rerender } = renderReplay();
    act(() => result.current.seek(1));
    expect(result.current.position).toBe(4);

    const other = [makeEvent('agent.registered', 'bruno', { name: 'Bruno Díaz' }, { id: 'o1', at: T0 })];
    rerender({ events: other, opts: undefined });
    expect(result.current.position).toBe(0);
    expect(result.current.total).toBe(1);
  });

  it('only reveals events, never creates them', () => {
    const { result } = renderReplay();
    act(() => result.current.seek(1));
    expect(result.current.events.every((event) => run.includes(event))).toBe(true);
  });
});

describe('ReplayControls', () => {
  function Player({ locale, events = run }: { locale?: string; events?: OfficeEventInput[] }) {
    const replay = useEventReplay(events);
    return <ReplayControls replay={replay} locale={locale} />;
  }

  it('has Spanish accessible names', () => {
    render(<Player locale="es" />);

    expect(screen.getByRole('group', { name: 'Controles de repetición' })).toBeTruthy();
    const play = screen.getByRole('button', { name: 'Reproducir' });
    expect(play.getAttribute('title')).toBe('Reproducir');
    expect(screen.getByRole('button', { name: 'Volver al inicio' })).toBeTruthy();
    const slider = screen.getByRole('slider', { name: 'Posición de la repetición' });
    expect(slider.getAttribute('aria-valuetext')).toBe('0%');
    expect(screen.getByRole('group', { name: 'Velocidad' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(play);
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reproducir' })).toBeNull();
  });

  it('has English accessible names by default', () => {
    render(<Player />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to start' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Replay position' })).toBeTruthy();
  });

  it('seeks, changes speed and resets through the controls', () => {
    render(<Player locale="es" />);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.5' } });
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('50%');

    fireEvent.click(screen.getByRole('button', { name: '2x' }));
    expect(screen.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Volver al inicio' }));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('0%');
  });

  it('disables the controls when there is nothing to replay', () => {
    render(<Player locale="es" events={[]} />);
    expect((screen.getByRole('button', { name: 'Reproducir' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Volver al inicio' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  });
});
