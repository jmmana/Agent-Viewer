# Room ambience (#148)

Crew's **Ambience / Ambiente** selector changes the selected room between dawn,
day, sunset and night. **Auto (local time)** uses the browser's local clock:
05:00–07:59 dawn, 08:00–16:59 day, 17:00–19:59 sunset, and night otherwise.
This is a decorative schedule, not calculated sunrise/sunset or event/replay time.
It requires no location permission. Rooms default to day until configured.

Each room stores its own override in `CrewPreferences.ambienceByRoom`, within the
existing `agent-viewer-crew-preferences-v1` storage in the application. Reloading
or switching visual modes preserves it. **Reset Crew preferences** clears it.
Embedded hosts can control it through `crewPreferences` and the existing change
callback, exactly like other Crew preferences. Unknown rooms and invalid modes
are discarded during preference validation; previous v1 values still work.

## Rendering and artwork

`crewAmbience.ts` defines palettes and deterministic clock resolution.
`crewAmbienceLayer.ts` draws four fixed windows in room-local coordinates,
showing only the two walls retained by the active cutaway camera. Original
procedural skylines, glass, night building lights and bounded floor light/shadow
patches use the same projection as the room at all four angles, pan and zoom.
The room shell changes its wall/floor/background palette and geometric monitors
change their top-face brightness. Actors, labels and event data remain readable.
The renderer itself takes a resolved phase and never reads the clock.

All new visual elements are original Canvas geometry in these two source files,
licensed under the repository MIT license. They are **prototype**, pending visual
acceptance, and require no downloaded images, fonts, textures or asset-bank
manifest entries. Failed character/furniture images retain existing fallbacks;
window rendering has no network dependency. This is not a physical lighting
engine, custom skyline editor, or the lamp-switch feature tracked in #149.
Illustrated workstation monitors retain their existing artwork.

High contrast takes priority over ambient wall/floor/screen colors and removes
floor light patches. Changes are immediate, without animated transitions or
sound, including with reduced motion. Controls and the resolved-phase status
support Spanish/English and keyboard access. Automatic mode checks the local hour
every 30 seconds and on window focus; its interval/listener are removed when
manual mode is selected or the stage unmounts. No agents, work or events are
created by selecting an ambience, in LIVE, DEMO or REPLAY.

## Verification and evidence

```sh
npm run lint
npm run test:unit
npm run test:node
npm run build
npm run build:lib
npx playwright test tests/e2e/crew-ambience-148.spec.ts tests/e2e/crew-camera.spec.ts tests/e2e/crew-preferences-171.spec.ts tests/e2e/crew-embedded.spec.ts
```

`tests/lib/crewAmbience.test.ts` covers clock boundaries, validation, all rooms
and camera directions, and high contrast. `crewAmbienceStage.test.tsx` covers
controlled preferences with empty LIVE/DEMO/REPLAY rooms and clock cleanup.
The ambience E2E checks actual canvas background pixels, two isolated offices,
four cameras, zoom/pan, persistence, Cartoon round-trip, reduced motion, high
contrast, desktop/mobile and a simulated automatic clock transition.

See [runtime evidence](evidence/ambience-148/README.md). Visual acceptance and
physical-device QA remain review steps; this change does not certify Epic #114 G1.
