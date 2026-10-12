# Desk, ceiling, wall and reception lamps (#149)

Each Crew room exposes a fixed catalog of procedural lamps: one fixture per
desk (a reception fixture in Reception), one ceiling fixture, and four wall
fixtures. Every lamp has its own manual **On / Off / Auto** mode. **Auto**
follows the room's resolved [ambience](AMBIENCE.md): off at dawn/day, on at
sunset/night. It never reads a different room's ambience or the legacy
(Cartoon) lighting state.

## Interaction

- **Click/tap the fixture on the canvas.** A short tap (not a drag, pinch or
  cancelled pointer) cycles that lamp's mode `auto → on → off → auto`.
- **Office lights** panel, below the accessibility/audio panel: one button per
  visible lamp (same three-state cycle, fully keyboard-reachable via Tab and
  Enter/Space) plus a room-wide **All: On / Off / Auto** control that sets
  every lamp in the active room at once.

Both paths write to the same state and never invent a different one from the
other. A wall fixture hidden by the current cutaway camera has no button and
cannot be tapped on the canvas, but its state is still controllable from the
room-wide "All" control and still affects the render once that wall becomes
visible again.

## Persistence and isolation

Each room stores its own `lampsByRoom[roomId][lampId]` override in
`CrewPreferences`, within the existing `agent-viewer-crew-preferences-v1`
storage. Reloading, switching rooms or round-tripping through Cartoon
preserves it; **Reset Crew preferences** clears it. Unknown rooms, unknown
lamp ids and invalid modes are discarded during validation; existing v1 values
without `lampsByRoom` keep working unchanged.

## Rendering

`crewLamps.ts` defines the per-room catalog, the on/off resolution, the manual
mode cycle and a bounded local illumination falloff. `crewLampLayer.ts` draws
each fixture (desk, ceiling, wall, reception silhouettes) and a flat light
pool beneath lit fixtures, using concentric polygons instead of canvas shadow
blur. `crewLampHitTest.ts` projects a lamp to screen space for click/tap
hit-testing and holds the tap-vs-drag pointer state machine. Lit desks make
their screen prop glow faintly brighter in `crewPropsLayer.ts`; nothing else
about furniture, actors or events changes. Light never spills past a lamp's
own radius into the rest of the room or into another room.

All new visual elements are original Canvas geometry, licensed under the
repository MIT license. They are **prototype**, pending visual acceptance, and
require no downloaded images, textures or asset-bank manifest entries. This is
not a physical lighting engine.

## Verification and evidence

```sh
npm run lint
npm run test:unit
npx playwright test tests/e2e/crew-lamps-149.spec.ts tests/e2e/crew-ambience-148.spec.ts tests/e2e/crew-camera.spec.ts
```

`tests/lib/crewLamps.test.ts` covers the catalog shape, on/off resolution, the
manual cycle, preference validation, cutaway visibility and the illumination
falloff. `tests/lib/crewLampHitTest.test.ts` covers screen-space hit-testing
and the tap/drag/pinch/cancel pointer state machine in isolation.
`tests/lib/crewLampStage.test.tsx` covers the `CrewStage` wiring: per-lamp and
room-wide controls, and room isolation. The lamps E2E spec drives a real
canvas click at a lamp's exact projected point, the same action through a drag
(confirming it never toggles a light), the accessible button and global
controls, an automatic night transition, zoom/pan stability, room isolation, a
Cartoon round-trip and a reload.

See [runtime evidence](evidence/lamps-149/README.md). Visual acceptance and
physical-device QA remain review steps; this change does not certify Epic
#114 G1.
