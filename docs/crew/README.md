# Crew mode: the public guide

Issue [#160](https://github.com/jmmana/Agent-Viewer/issues/160), part of Epic
[#114](https://github.com/jmmana/Agent-Viewer/issues/114). This is the entry
point for anyone evaluating Agent Viewer who has not read the implementation
docs: what Cartoon and Crew actually are today, how to switch between them,
what each control does, and, just as important, what is still a placeholder.
Every claim below is checked against the real source tree and tests, not
against a design intention; see
[docs/crew/IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for the full,
issue-by-issue ledger this guide summarizes.

Crew is in **Beta**. It does not replace Cartoon mode, and Cartoon mode is not
touched by anything described here.

## 1. Two modes, side by side

Agent Viewer ships two independent visual modes for the same underlying
event/agent/usage data. Switching modes never resets agents, tasks, costs or
replay state; it only changes which renderer draws the office.

| | Cartoon (legacy) | Crew (new, Beta) |
| --- | --- | --- |
| Purpose | The original office view, unchanged | A new illustrated-office renderer, built independently |
| Renderer | Its own canvas and camera, not touched by Crew work | Its own canvas/camera/scene lifecycle, never imports Cartoon's drawing code |
| Rooms | One shared office floor | 11 separate rooms, selected one at a time |
| Camera | Legacy pan/zoom | Zoom, pan, 4 facings (front/right/back/left) and reset, per room |
| Characters | Legacy sprites | 6 cosmetic archetypes with a customization editor; most art is still placeholder (see section 4) |
| Status | Stable, production | Beta: some rooms and roles have real illustrated art and tested animation, most do not yet |

You switch modes from the toolbar button in the demo app: it reads **Cartoon**
(or **Caricatura** in Spanish) and **Crew · Beta**. That exact label is what
the automated reproduction script in section 6 clicks, so if you ever see a
different label in the running app, this guide (and the script) are out of
date and that itself is a bug worth filing.

## 2. Choosing an office, and why you only see one

Crew models each office as an independent scene: Direction/CEO, Planning,
Development, Research/Analyst, QA/Reviewer, Finance, Meetings,
Infrastructure/War Room, Lounge/Coffee and Reception. The room selector
(`#crew-room` in the DOM, issue
[#168](https://github.com/jmmana/Agent-Viewer/issues/168)) is a searchable,
keyboard-operable dropdown. Picking a room mounts **only that room**: its own
walls, floor, furniture and agents. No other room's sprites render, and no
other room's events are lost while it is hidden (issue
[#169](https://github.com/jmmana/Agent-Viewer/issues/169)); switching back
restores it exactly as it was. A marker reported as walking moves across that
room's real floor, around its furniture, instead of jumping straight to its
destination (issue [#129](https://github.com/jmmana/Agent-Viewer/issues/129),
contract in [NAVIGATION.md](NAVIGATION.md)); it never walks between rooms, or
around other agents, only around furniture within the one room shown.

## 3. Camera: zoom, pan, facing and reset

Each room keeps its own camera state (issue
[#156](https://github.com/jmmana/Agent-Viewer/issues/156), decision recorded
in [ADR-001](../adr/ADR-001-crew-camera.md)):

- **Facing** (`#crew-view`): four discrete 2.5D presets, front/right/back/left.
  This is not a 3D orbit; the ADR explicitly rules out faking perspective with
  2D canvas rotation. Rotating the camera around a character shows its correct
  relative side, not a mirrored or frozen front sprite.
- **Zoom**: mouse wheel, or pinch with two fingers on touch devices, anchored
  to the cursor/pinch midpoint, continuous between roughly 0.5x and 3x.
- **Pan**: click-drag on desktop, one-finger drag on touch, clamped so you
  cannot pan the room out of view.
- **Keyboard**: arrow keys pan, `+`/`-` zoom, `Home` resets, all without
  leaving the canvas.
- **Focus** (`#crew-focus`): jumps the camera to a specific piece of furniture
  or agent inside the current room.
- **Fit room**: the button labeled **Fit room** (**Ajustar** in Spanish)
  restores the initial framing for the active room.

Changing rooms and returning to a room later restores that room's own camera
preference; it is never shared across rooms or reset by switching to Cartoon
and back (issue [#171](https://github.com/jmmana/Agent-Viewer/issues/171)).

The **Ambience** selector sets dawn/day/sunset/night independently for each room,
or follows the local clock in **Auto**. Windows, skyline, room colors and geometric
monitor brightness follow the chosen phase, including after reloading. See
[Room ambience](AMBIENCE.md) for the schedule, persistence and prototype-art limits.

Each room's desk, ceiling, wall and reception fixtures have their own manual
On/Off/Auto switch, by click/tap on the canvas or from the keyboard-reachable
**Office lights** panel; Auto follows the room's ambience. See
[Lamps](LAMPS.md) for persistence, isolation and prototype-art limits.

## 4. Characters: what is customizable today, and what is still placeholder

Crew defines 6 cosmetic archetypes (CEO, Planner, Developer, Analyst,
Reviewer, Finance) that are deliberately independent from an agent's
functional role; an agent can "wear" any of the six without changing what it
actually does. Issue [#127](https://github.com/jmmana/Agent-Viewer/issues/127)
ships a working customization editor (hair/skin/clothing/footwear/accessory
categories, per-agent save, a 4-view preview) with full round-trip tests.
Open it from each agent's own **Customize appearance** panel, below its name
in the room's agent list.

**What this honestly does not include yet:** the editor operates on a catalog
of explicit `placeholder` entries, not final illustrated art. Real,
rights-cleared appearance art and a modular hair/skin/clothing library are
issues [#125](https://github.com/jmmana/Agent-Viewer/issues/125) and
[#126](https://github.com/jmmana/Agent-Viewer/issues/126), both still fully
pending. Only the CEO role has real walking/idle art today (prototype
quality, see [FRAME-PIPELINE.md](FRAME-PIPELINE.md)); the other five roles
only have a static `idle-front` sprite. Deciding the final art direction for
any of this is a call for the product owner, not something this guide or an
automated agent can resolve.

## 5. LIVE, DEMO and REPLAY

Crew can show a badge stating whether what you are looking at is `LIVE`,
`DEMO` or `REPLAY` (issue [#155](https://github.com/jmmana/Agent-Viewer/issues/155),
contract documented in [EMBEDDED-API.md](EMBEDDED-API.md)). This is never
inferred from the event stream: the host application decides and passes the
value explicitly, so an integrator is responsible for labeling fictional demo
data honestly. Without that prop, Crew shows no badge at all rather than
guessing.

## 6. Reproducible evidence: see it running yourself

This guide intentionally does not ship a new polished marketing video. That
kind of production asset mixes art direction and editing choices that belong
to the product owner, not to a documentation pass, and the Epic #114 gate for
that ("G1") explicitly has not been certified yet (see section 8). What this
guide does provide, and what issue #160 asks for as a minimum, is a real,
scripted way for anyone to reproduce current Crew behavior from a clean
checkout.

Run the existing capture script against a local dev server:

```sh
npm run dev
# in a second terminal
PLAYWRIGHT_CHANNEL=chrome npm run crew:capture
```

(If you don't have the system Chrome channel, run
`npx playwright install chromium` once and drop the `PLAYWRIGHT_CHANNEL`
variable.) This drives a real Chromium browser through: opening Crew,
visiting the CEO and Development rooms, cycling all four camera facings in
each, focusing a desk, fitting the room, returning to Cartoon, and switching
back to Crew after a reload. It writes a real screen recording to
`test-results/crew-demo/runtime.webm`. Optional conversion to MP4:

```sh
ffmpeg -i test-results/crew-demo/runtime.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime-navigation.mp4
```

This is the same command documented in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), and the script it runs
(`scripts/capture-crew-runtime.mjs`) is version-controlled, so the recording
is always reproducible, never a one-off claim. Earlier issues already
produced and committed recordings and screenshots from real runs of this kind
of script; browse them under [evidence/](evidence/), most relevantly
[evidence/camera-156/](evidence/camera-156/) (two rooms, all four facings,
desk focus, mobile pinch, Cartoon round-trip) and
[evidence/engine-167/](evidence/engine-167/) (empty-room mount/unmount,
desktop and mobile). None of it is a rendered mockup: every PNG and video
under `evidence/` comes from an actual browser session against the real app.

## 7. Assets, licensing and pipeline

- [visual-style-contract.md](visual-style-contract.md): the art contract (canvas
  size, anchors, lifecycle states, the six role palette/silhouette cards) that
  any future Crew art must follow.
- [ASSET-MIGRATION-PR43.md](ASSET-MIGRATION-PR43.md): provenance and
  destination of every asset recovered from the earlier `#43` exploration
  branch; nothing from there is treated as finished Crew art.
- [FRAME-PIPELINE.md](FRAME-PIPELINE.md) ([Spanish twin](FRAME-PIPELINE.es.md)):
  how the CEO's walking atlas was produced, licensed and versioned, the only
  pipeline example that exists end to end today.
- [AUDIO_LICENSES.md](AUDIO_LICENSES.md): every sound Crew can play is
  synthesized in-browser (no recorded sample, no third-party IP), audio is
  opt-in and muted by default.

## 8. Verifiable status, module by module

This guide does not duplicate the full per-issue table; it would drift the
moment a new PR lands. The canonical, continuously updated source is
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), which lists, for every
issue in Epic #114, whether it is closed or only referenced, which PR and CI
run verified it, and what explicitly remains out of scope. As of this guide,
that ledger shows: the engine, room registry/selector, camera, spatial
layout/collisions, navigation, animation controller and two-mode contract all
have real, tested code in main; most room furniture, five of six character
roles, meetings choreography and the production "G1" video gate do
not yet.

## 9. What is explicitly out of scope here

This guide is documentation and a verification test for the commands it
documents, not new product functionality. The following remain, on purpose,
untouched by issue #160:

- **Final illustrated art** for rooms, furniture and the five non-CEO roles.
  That is art direction, a decision for the product owner, not something a
  documentation pass can or should fabricate.
- **A new polished production MP4/GIF.** Section 6 gives a real, scripted,
  reproducible capture instead; turning that into marketing material is a
  separate, later decision.
- **G1 certification** for Epic #114. G1 requires final art across rooms and
  roles and physical-device QA; neither exists yet, so this guide does not
  claim it does.
- **Retiring Cartoon mode.** Cartoon remains the default, stable mode until a
  separate, explicit decision says otherwise.

## 10. Keep this guide honest

If you change a toggle label, a control id, an npm script name, or move an
evidence file referenced above, update this guide and its Spanish twin,
[README.es.md](README.es.md), in the same change.
[tests/docs-crew-public-guide.test.mjs](../../tests/docs-crew-public-guide.test.mjs)
runs on every `npm run test:node` and fails the build if either guide drifts
from the real commands, files or control ids it documents.
