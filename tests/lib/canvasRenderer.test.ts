import { describe, expect, it } from 'vitest';
import { AGENT_BADGE_COLORS, renderOfficeScene, type AgentBadge, type CameraState } from '../../src/engine/canvasRenderer';
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

interface RecordedText { text: string; x: number; y: number }
interface RecordedRect { x: number; y: number; width: number; height: number; radius: number }

/**
 * A 2D context that records every text drawn with `fillText` or `strokeText` (with its position) and every
 * rounded rectangle drawn with `roundRect` (with its radius, so a test can pick out agent cards: they are
 * the only caller using radius 9). Gradients and patterns are stubs, `measureText` returns 6 px per
 * character, and every other call or property write is accepted and ignored.
 */
function createRecordingContext(): { ctx: CanvasRenderingContext2D; texts: string[]; textCalls: RecordedText[]; rects: RecordedRect[] } {
  const texts: string[] = [];
  const textCalls: RecordedText[] = [];
  const rects: RecordedRect[] = [];
  const gradient = { addColorStop() {} };
  const properties = new Map<PropertyKey, unknown>();
  const noop = () => undefined;
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, property) {
      if (property === 'fillText' || property === 'strokeText') {
        return (text: unknown, x: unknown, y: unknown) => {
          texts.push(String(text));
          textCalls.push({ text: String(text), x: Number(x), y: Number(y) });
        };
      }
      if (property === 'roundRect') {
        return (x: unknown, y: unknown, width: unknown, height: unknown, radius: unknown) => {
          rects.push({ x: Number(x), y: Number(y), width: Number(width), height: Number(height), radius: Number(radius) });
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
  return { ctx, texts, textCalls, rects };
}

/** Rectangles of every agent card drawn this frame: cards are the only `roundRect` caller using radius 9. */
function agentCardRects(rects: readonly RecordedRect[]): RecordedRect[] {
  return rects.filter((rect) => rect.radius === 9);
}

function rectsOverlap(a: RecordedRect, b: RecordedRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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

interface DrawOptions {
  usageTelemetry?: boolean;
  agents?: Agent[];
  activeMeetingId?: string | null;
  agentBadges?: ReadonlyMap<string, AgentBadge>;
  theme?: 'dark' | 'light';
  width?: number;
  height?: number;
  camera?: CameraState;
}

function drawScene(translate: OfficeTranslate, options: DrawOptions = {}) {
  const recording = createRecordingContext();
  renderOfficeScene({
    ctx: recording.ctx,
    width: options.width ?? WIDTH,
    height: options.height ?? HEIGHT,
    camera: options.camera ?? centeredCamera(),
    agents: options.agents ?? sceneAgents(),
    selectedAgentId: null,
    hoveredAgentId: null,
    activeMeetingId: options.activeMeetingId ?? null,
    timeMs: 1000,
    theme: options.theme ?? 'dark',
    translate,
    usageTelemetry: options.usageTelemetry,
    agentBadges: options.agentBadges,
    nowMs: NOW + 100,
    reducedMotion: true,
  });
  return recording;
}

function draw(translate: OfficeTranslate, options: DrawOptions = {}) {
  return drawScene(translate, options).texts;
}

const spanish = createOfficeTranslator({ locale: 'es' });
const english = createOfficeTranslator({ locale: 'en' });

describe('renderOfficeScene: canvas texts', () => {
  it('draws agent cards and the bubble of the speaking agent', () => {
    const texts = draw(spanish);
    expect(texts).toContain('Ana Rivas');
    expect(texts).toContain('Desarrollador · Programando');
    expect(texts).toContain('Probando');
    expect(texts).toContain('OBJETA');
    expect(texts).toContain('Ana Rivas → Bruno Díaz');
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

  it('never labels a real message as simulated, whatever the agent status', () => {
    const snapshot = buildOfficeSnapshot(
      [
        registered('ana', 'Ana Rivas', { workspace: 'leads_area' }, { at: T0 }),
        statusChanged('ana', 'CHATTING', { at: T0 + 10 }),
        messageSent('ana', 'Video recibido.', {}, { at: T0 + 20 }),
      ],
      { now: NOW },
    );
    const texts = draw(spanish, { agents: snapshot.agents });
    expect(texts.join('\n')).toContain('Video recibido.');
    expect(texts).not.toContain('SOCIAL · SIMULADO');
    expect(texts).toContain('ACTIVIDAD');
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
    expect(texts).toContain('DE ACUERDO');
    expect(texts).toContain('Bruno Díaz');
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
    expect(texts).toContain('OBJECTS');
    expect(texts).toContain('Ana Rivas → Bruno Díaz');
    expect(findEnglishLeaks(texts).length).toBeGreaterThan(5);
  });

  it('draws every text through the host translator', () => {
    const custom = createOfficeTranslator({ locale: 'es', messages: { 'rooms.development': 'TALLER DE CÓDIGO', 'kind.objection': 'SE OPONE' } });
    const texts = draw(custom);
    expect(texts).toContain('TALLER DE CÓDIGO');
    expect(texts).not.toContain('INGENIERÍA');
    expect(texts).toContain('SE OPONE');
  });
});

/**
 * N agents spread round robin across rooms, so they do not all land on the same desk. Role titles are host
 * data and are never translated (as `spanishTeam` in the other test file notes), so a Spanish scene must use
 * a Spanish-looking name and role to avoid a false English-leak match against unrelated host text.
 */
function buildAgents(n: number, locale: 'es' | 'en' = 'es'): Agent[] {
  const rooms = ['leads_area', 'development', 'qa_lab', 'research_area', 'break_room', 'lounge'];
  const roleTitle = locale === 'es' ? 'Ingeniera' : 'Engineer';
  const namePrefix = locale === 'es' ? 'Persona' : 'Member';
  const events = Array.from({ length: n }, (_, i) =>
    registered(`agent-${i}`, `${namePrefix} ${i}`, { roleTitle, workspace: rooms[i % rooms.length] }, { at: T0 + i }));
  return buildOfficeSnapshot(events, { mode: 'professional', now: NOW }).agents;
}

/** One agent only, so exactly one card (radius 9) is drawn and its height reflects the badge row count. */
function singleAgent(): Agent[] {
  return buildOfficeSnapshot([registered('solo', 'Solo Agent', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 })], { now: NOW }).agents;
}

/** Worst-case Spanish segments: each individually short, but requiring 3 rows together (acceptance criteria). */
const WORST_CASE_ES_BADGE: AgentBadge = { tokens: 'desconocido', costLabel: 'desconocido est.', failed: '99 fallidas' };

describe('renderOfficeScene: agent usage badges', () => {
  it('draws no badge text and no extra card height when agentBadges is undefined', () => {
    const { texts, rects } = drawScene(spanish, { agents: singleAgent() });
    expect(texts).not.toContain('desconocido');
    expect(texts.filter((t) => t.includes('est.') || t.includes('fallidas'))).toEqual([]);
    expect(agentCardRects(rects)).toEqual([expect.objectContaining({ height: 38 })]);
  });

  it('draws no badge text when agentBadges is given but empty', () => {
    const { texts, rects } = drawScene(spanish, { agents: singleAgent(), agentBadges: new Map() });
    expect(texts).not.toContain('desconocido');
    expect(agentCardRects(rects)).toEqual([expect.objectContaining({ height: 38 })]);
  });

  it('draws a badge only for the agent that has an entry', () => {
    const agents = sceneAgents(); // ana, bruno, carla
    const badges = new Map<string, AgentBadge>([
      ['ana', { tokens: '9,840', costLabel: '$0.42', failed: null }],
      ['carla', { tokens: '12.3K', costLabel: '<$0.01', failed: '2 failed' }],
    ]);
    const { texts, rects } = drawScene(english, { agents, agentBadges: badges });

    expect(texts).toContain('9,840');
    expect(texts).toContain('$0.42');
    expect(texts).toContain('12.3K');
    expect(texts).toContain('<$0.01');
    expect(texts).toContain('2 failed');
    // Ana has no failed chip, Bruno has no entry at all: neither card grows past the no-badge height.
    const cards = agentCardRects(rects);
    expect(cards.filter((c) => c.height === 38).length).toBe(1); // bruno only
  });

  it('never imports the demo telemetry aggregator for the badge path (source check)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/engine/canvasRenderer.ts'), 'utf8');
    const badgeSection = source.slice(source.indexOf('function badgeSegments'), source.indexOf('function drawAgentOverlays'));
    expect(badgeSection).not.toMatch(/aggregateModelUsage|compactTokens/);
  });

  it.each([
    ['one row', { tokens: '9,840', costLabel: '$0.42', failed: null }, 52],
    ['two rows', { tokens: 'desconocido', costLabel: 'desconocido est.', failed: null }, 66],
    ['three rows (worst-case Spanish)', WORST_CASE_ES_BADGE, 80],
  ] as const)('sizes the card to %s of badge text', (_label, badge, expectedHeight) => {
    const { rects } = drawScene(spanish, { agents: singleAgent(), agentBadges: new Map([['solo', badge]]) });
    const cards = agentCardRects(rects);
    expect(cards).toHaveLength(1);
    expect(cards[0].height).toBe(expectedHeight);
    expect(cards[0].width).toBeLessThanOrEqual(190);
    expect(cards[0].width).toBeGreaterThanOrEqual(112);
  });

  it('never truncates badge text, even the longest Spanish case', () => {
    const { texts } = drawScene(spanish, { agents: singleAgent(), agentBadges: new Map([['solo', WORST_CASE_ES_BADGE]]) });
    expect(texts).toContain('desconocido');
    expect(texts).toContain('desconocido est.');
    expect(texts).toContain('99 fallidas');
    expect(texts.some((t) => t.includes('…') && (t.includes('desconocido') || t.includes('fallidas')))).toBe(false);
  });

  it.each([1, 5, 12])('keeps %d badged cards non-overlapping and inside the viewport at zoom 1.0', (count) => {
    const agents = buildAgents(count);
    const badges = new Map(agents.map((a) => [a.id, WORST_CASE_ES_BADGE] as const));
    const { rects } = drawScene(spanish, { agents, agentBadges: badges, camera: { ...centeredCamera(), zoom: 1 } });
    const cards = agentCardRects(rects);
    for (let i = 0; i < cards.length; i++) {
      expect(cards[i].x).toBeGreaterThanOrEqual(0);
      expect(cards[i].y).toBeGreaterThanOrEqual(0);
      expect(cards[i].x + cards[i].width).toBeLessThanOrEqual(WIDTH);
      expect(cards[i].y + cards[i].height).toBeLessThanOrEqual(HEIGHT);
      for (let j = i + 1; j < cards.length; j++) {
        expect(rectsOverlap(cards[i], cards[j])).toBe(false);
      }
    }
  });

  it.each([1, 5, 12])('keeps %d badged cards non-overlapping and inside the viewport at zoom 0.6', (count) => {
    const agents = buildAgents(count, 'en');
    const badges = new Map(agents.map((a) => [a.id, WORST_CASE_ES_BADGE] as const));
    const { rects } = drawScene(english, { agents, agentBadges: badges, camera: { ...centeredCamera(), zoom: 0.6 } });
    const cards = agentCardRects(rects);
    for (let i = 0; i < cards.length; i++) {
      expect(cards[i].x + cards[i].width).toBeLessThanOrEqual(WIDTH);
      expect(cards[i].y + cards[i].height).toBeLessThanOrEqual(HEIGHT);
      for (let j = i + 1; j < cards.length; j++) {
        expect(rectsOverlap(cards[i], cards[j])).toBe(false);
      }
    }
  });

  it('finds no English leak in a Spanish scene with badges on', () => {
    const agents = buildAgents(5);
    const badges = new Map(agents.map((a) => [a.id, WORST_CASE_ES_BADGE] as const));
    const { texts } = drawScene(spanish, { agents, agentBadges: badges });
    expect(findEnglishLeaks(texts)).toEqual([]);
  });

  it('meets WCAG AA contrast (4.5:1) for badge text against the card background, both themes', () => {
    // Relative luminance per WCAG 2.x, then the standard contrast ratio formula.
    const srgb = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    };
    const contrast = (a: string, b: string) => {
      const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    for (const theme of ['dark', 'light'] as const) {
      const { background, secondary, failed } = AGENT_BADGE_COLORS[theme];
      expect(contrast(secondary, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(failed, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
