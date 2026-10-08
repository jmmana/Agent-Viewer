import { describe, expect, it } from 'vitest';
import { renderOfficeScene, type CameraState } from '../../src/engine/canvasRenderer';
import { getOfficeRenderedBounds } from '../../src/engine/officeModel';
import {
  OFFICE_MESSAGES,
  buildOfficeSnapshot,
  createOfficeTranslator,
  type Agent,
  type OfficeTranslate,
} from '../../src/lib/index';
import { T0, findEnglishLeaks, meetingMessage, meetingRequested, messageSent, registered, statusChanged } from './fixtures';

const NOW = 1_900_000_000_000;
const WIDTH = 1280;
const HEIGHT = 900;

/**
 * A 2D context that records every text drawn with `fillText` or `strokeText`. Gradients and patterns are
 * stubs, `measureText` returns 6 px per character, and every other call or property write is accepted and
 * ignored.
 */
function createRecordingContext(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[] = [];
  const gradient = { addColorStop() {} };
  const properties = new Map<PropertyKey, unknown>();
  const noop = () => undefined;
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, property) {
      if (property === 'fillText' || property === 'strokeText') {
        return (text: unknown) => {
          texts.push(String(text));
        };
      }
      if (property === 'createLinearGradient' || property === 'createRadialGradient' || property === 'createPattern' || property === 'createConicGradient') {
        return () => gradient;
      }
      if (property === 'measureText') return (text: unknown) => ({ width: String(text).length * 6 });
      if (properties.has(property)) return properties.get(property);
      return noop;
    },
    set(_target, property, value) {
      properties.set(property, value);
      return true;
    },
  });
  return { ctx, texts };
}

function centeredCamera(): CameraState {
  const bounds = getOfficeRenderedBounds(0);
  return { x: -bounds.centerX, y: -bounds.centerY, zoom: 1, rotation: 0 };
}

/** Three agents built from events; Ana objects to Bruno right now. */
function sceneAgents(): Agent[] {
  const snapshot = buildOfficeSnapshot(
    [
      registered('ana', 'Ana Rivas', { roleTitle: 'Arquitecta', workspace: 'leads_area' }, { at: T0 }),
      registered('bruno', 'Bruno Díaz', { roleTitle: 'Desarrollador', workspace: 'development' }, { at: T0 + 100 }),
      registered('carla', 'Carla Méndez', { workspace: 'qa_lab' }, { at: T0 + 200 }),
      statusChanged('bruno', 'CODING', { at: T0 + 300 }),
      statusChanged('carla', 'TESTING', { at: T0 + 400 }),
      messageSent('ana', 'La migración rompe la compatibilidad del contrato.', { kind: 'objection', targetAgentId: 'bruno' }, { at: T0 + 500 }),
    ],
    { mode: 'professional', now: NOW },
  );
  return snapshot.agents;
}

function draw(translate: OfficeTranslate, options: { usageTelemetry?: boolean; agents?: Agent[]; activeMeetingId?: string | null } = {}) {
  const { ctx, texts } = createRecordingContext();
  renderOfficeScene({
    ctx,
    width: WIDTH,
    height: HEIGHT,
    camera: centeredCamera(),
    agents: options.agents ?? sceneAgents(),
    selectedAgentId: null,
    hoveredAgentId: null,
    activeMeetingId: options.activeMeetingId ?? null,
    timeMs: 1000,
    theme: 'dark',
    translate,
    usageTelemetry: options.usageTelemetry,
    nowMs: NOW + 100,
    reducedMotion: true,
  });
  return texts;
}

const spanish = createOfficeTranslator({ locale: 'es' });
const english = createOfficeTranslator({ locale: 'en' });

describe('renderOfficeScene: canvas texts', () => {
  it('draws agent cards and the bubble of the speaking agent', () => {
    const texts = draw(spanish);
    expect(texts).toContain('Ana Rivas');
    expect(texts).toContain('Desarrollador · Programando');
    expect(texts).toContain('Probando');
    expect(texts).toContain('Ana → Bruno Díaz · OBJETA');
    expect(texts.join('\n')).toContain('La migración rompe');
  });

  it('draws only Spanish catalog texts and no usage figures in Spanish without telemetry', () => {
    const texts = draw(spanish, { usageTelemetry: false });

    expect(texts.filter((text) => text.includes('$'))).toEqual([]);
    expect(texts.filter((text) => / t$/.test(text))).toEqual([]);
    expect(findEnglishLeaks(texts)).toEqual([]);

    for (const room of ['INGENIERÍA', 'SALA DE REUNIÓN A', 'LAB QA', 'ARQUITECTURA', 'DIRECCIÓN']) {
      expect(texts).toContain(room);
    }
    expect(texts.some((text) => text.includes('OBJETA'))).toBe(true);
    expect(texts.some((text) => text.includes('OBJECTS'))).toBe(false);
    expect(texts).not.toContain(OFFICE_MESSAGES.es['screen.telemetry']);
  });

  it('stays in Spanish while a meeting is active', () => {
    const texts = draw(spanish, { activeMeetingId: 'm-1' });
    expect(texts).toContain('SALA DE REUNIÓN A');
    expect(findEnglishLeaks(texts)).toEqual([]);
  });

  it('uses the Spanish kind label in the header of a meeting message', () => {
    const snapshot = buildOfficeSnapshot(
      [
        registered('ana', 'Ana Rivas', { workspace: 'leads_area' }, { at: T0 }),
        registered('bruno', 'Bruno Díaz', { workspace: 'development' }, { at: T0 }),
        meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 10 }),
        meetingMessage('bruno', 'm-1', 'De acuerdo con el plan.', 'agreement', { at: T0 + 20 }),
      ],
      { now: NOW },
    );
    const texts = draw(spanish, { agents: snapshot.agents });
    expect(texts).toContain('Bruno · ACUERDA');
    expect(findEnglishLeaks(texts)).toEqual([]);
  });

  it('shows the telemetry header only when usageTelemetry is on', () => {
    const texts = draw(spanish, { usageTelemetry: true });
    expect(texts).toContain(OFFICE_MESSAGES.es['screen.telemetry']);
    expect(texts).toContain(OFFICE_MESSAGES.es['screen.tokenFlow']);
  });

  it('does not name the Model Ops furniture or mention tokens without telemetry', () => {
    const quiet = draw(spanish, { usageTelemetry: false });
    expect(quiet).not.toContain(OFFICE_MESSAGES.es['furniture.f_server_desk']);
    expect(quiet.filter((text) => /token/i.test(text))).toEqual([]);

    const loud = draw(spanish, { usageTelemetry: true });
    expect(loud).toContain(OFFICE_MESSAGES.es['furniture.f_server_desk']);
  });

  it('finds English texts when the scene is drawn in English (control)', () => {
    const texts = draw(english);
    expect(texts).toContain('ENGINEERING');
    expect(texts).toContain('Ana → Bruno Díaz · OBJECTS');
    expect(findEnglishLeaks(texts).length).toBeGreaterThan(5);
  });

  it('draws every text through the host translator', () => {
    const custom = createOfficeTranslator({ locale: 'es', messages: { 'rooms.development': 'TALLER DE CÓDIGO', 'kind.objection': 'SE OPONE' } });
    const texts = draw(custom);
    expect(texts).toContain('TALLER DE CÓDIGO');
    expect(texts).not.toContain('INGENIERÍA');
    expect(texts).toContain('Ana → Bruno Díaz · SE OPONE');
  });
});
