import { describe, expect, it } from 'vitest';
import { CrewLampTap, crewLampScreenPoint, hitCrewLamp } from '../../src/crew/crewLampHitTest';
import { CREW_LAMPS_BY_ROOM, crewLampVisible } from '../../src/crew/crewLamps';
import { defaultCrewCamera } from '../../src/crew/crewCamera';
import { CREW_ROOMS } from '../../src/crew/crewModel';

const room = CREW_ROOMS.find(item => item.id === 'ceo')!;
const camera = defaultCrewCamera();
const viewport = { width: 800, height: 600 };

describe('Crew lamp hit testing #149', () => {
  it('hits the lamp under an exact screen point and nothing far away', () => {
    const lamps = CREW_LAMPS_BY_ROOM[room.id];
    const lamp = lamps.find(item => item.kind === 'desk')!;
    const point = crewLampScreenPoint(lamp, room, camera, viewport);
    expect(hitCrewLamp(point, lamps, room, camera, viewport)?.id).toBe(lamp.id);
    expect(hitCrewLamp({ x: -10_000, y: -10_000 }, lamps, room, camera, viewport)).toBeUndefined();
  });

  it('never hits a lamp that falls outside the viewport', () => {
    const lamps = CREW_LAMPS_BY_ROOM[room.id];
    const lamp = lamps.find(item => item.kind === 'desk')!;
    const point = crewLampScreenPoint(lamp, room, camera, viewport);
    expect(hitCrewLamp(point, lamps, room, camera, { width: 1, height: 1 })).toBeUndefined();
  });

  it('prefers the closest lamp when two desks sit in the same office', () => {
    const development = CREW_ROOMS.find(item => item.id === 'development')!;
    const lamps = CREW_LAMPS_BY_ROOM[development.id];
    const [first, second] = lamps.filter(item => item.kind === 'desk');
    expect(first.id).not.toBe(second.id);
    const point = crewLampScreenPoint(first, development, camera, viewport);
    expect(hitCrewLamp(point, lamps, development, camera, viewport)?.id).toBe(first.id);
  });

  it('ignores a wall fixture hidden by the current cutaway wall', () => {
    const lamps = CREW_LAMPS_BY_ROOM[room.id];
    const hiddenWallLamp = lamps.find(item => item.kind === 'wall' && !crewLampVisible(item, room, camera.view));
    expect(hiddenWallLamp).toBeDefined();
    const point = crewLampScreenPoint(hiddenWallLamp!, room, camera, viewport);
    expect(hitCrewLamp(point, lamps, room, camera, viewport)?.id).not.toBe(hiddenWallLamp!.id);
  });
});

describe('CrewLampTap', () => {
  it('reports a tap when the pointer does not move past the drag threshold', () => {
    const tap = new CrewLampTap();
    tap.start(1, { x: 10, y: 10 });
    tap.move(1, { x: 12, y: 11 });
    expect(tap.end(1, { x: 12, y: 11 })).toBe(true);
  });

  it('never reports a tap after a drag past the threshold', () => {
    const tap = new CrewLampTap();
    tap.start(1, { x: 10, y: 10 });
    tap.move(1, { x: 40, y: 10 });
    expect(tap.end(1, { x: 40, y: 10 })).toBe(false);
  });

  it('never reports a tap once a second pointer joins (pinch), even after it lifts', () => {
    const tap = new CrewLampTap();
    tap.start(1, { x: 10, y: 10 });
    tap.start(2, { x: 50, y: 50 });
    expect(tap.end(2, { x: 50, y: 50 })).toBe(false);
    expect(tap.end(1, { x: 10, y: 10 })).toBe(false);
  });

  it('cancel discards the candidate so a lost capture never switches a light', () => {
    const tap = new CrewLampTap();
    tap.start(1, { x: 10, y: 10 });
    tap.cancel(1);
    expect(tap.end(1, { x: 10, y: 10 })).toBe(false);
  });

  it('clear discards every tracked pointer', () => {
    const tap = new CrewLampTap();
    tap.start(1, { x: 10, y: 10 });
    tap.clear();
    expect(tap.end(1, { x: 10, y: 10 })).toBe(false);
  });
});
