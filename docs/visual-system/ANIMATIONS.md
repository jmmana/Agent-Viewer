# Office Crew — Animation Contract v1

## Separation of concerns

`runtime event → authoritative agent state → visual presentation action → animation clip → Canvas2D renderer`

No animation is allowed to invent an agent's operational work state. Demo-only simulated social actions are possible when explicitly identified as simulated. Speech contents must come from actual events or be clearly flagged simulated.

## Clip naming

`<role>.<activity>.<facing>`; examples: `ceo.idle.front`, `developer.walk.left`, `planner.talk.right`.

- Facing: `front`, `back`, `left`, `right`.
- Transition clips: `sit`, `stand`, `turn` are finite; `idle`, `walk`, `work` are looping.
- Durations are **visual timing**, not a source of operational state or telemetry.
- Separate semantic effects from body animation: `effect.call`, `effect.wifi`, `effect.done`, `effect.blocked`.
- Multiagent meeting choreography is orchestrated by runtime logic, not a pre-rendered video.

## Suggested first animation budget

| Clip | Reference frames | FPS | Loop | Visual action |
|---|---:|---:|---|---|
| idle | 4 | 6 | yes | Slight breathing, blinking |
| walk | 6 | 10 | yes | Short steps, subtle arm swing, steady head |
| think | 4 | 5 | yes | Thoughtful hand, gaze up |
| talk | 6 | 8 | yes | Gentle talking/hand gesture |
| work | 6 | 8 | yes | Read/type at workstation |
| review | 6 | 6 | yes | Tablet inspection |
| phone | 6 | 8 | yes | Raise phone, gesture |
| blocked | 4 | 5 | yes | Concerned face, slight shoulder change |
| completed | 6 | 10 | no | Short restrained celebration |
| sit | 6 | 10 | no | Transition to seated work pose |
| stand | 6 | 10 | no | Transition from seated pose |
| approve | 6 | 8 | no | Confirmation gesture |

Numbers above are starting points for the artist, **not** existing clip claims. Render each clip consistently at the logical 64×88 box.

## Sprite sheet / atlas contract (future production assets)

- Prefer PNG or lossless WebP RGBA spritesheets; no opaque white backdrops.
- Every frame uses the same dimensions and feet anchor.
- Provide metadata with frame index/order, rect, duration and facing.
- Never derive frame geometry from the reference artwork contact sheet.
- Optimize packing without mixing scale and without trimming anchors unpredictably.
- Refuse missing frames gracefully: `idle.front` fallback → role fallback → current procedural Canvas rendering.

## State projections

| Runtime event/state | Visual suggestion |
|---|---|
| IDLE / AVAILABLE | idle loop |
| THINKING | think loop with optional neutral thought icon |
| READING / RESEARCHING | research/review at actual location |
| CODING / WRITING / USING_TOOL | work cycle and supported tool indicator |
| WAITING / WAITING_APPROVAL | standing or seated idle, waiting indicator |
| BLOCKED / ERROR | blocked visual and warning icon |
| DELEGATING | talk/gesture when there is a delegation event |
| REVIEWING / TESTING | review / test gesture |
| DONE | finite completed animation then idle |
| meeting event | walk to assigned meeting slot, sit, converse on actual message events |
| phone event | phone gesture plus standalone call/wifi effects |

## Rendering and accessibility guarantees

- The Canvas2D engine retains the current 24×16 rectangular scene and camera rotation.
- Animate only the presentation layer; external agent state remains authoritative.
- Respect `prefers-reduced-motion`: use a still pose and equivalent accessible status.
- Keep bubbles and agent labels in the overlay system (not within sprites).
- No unobserved background token use, invented conversations or fake model cost.
- Handle network/device effects without sending network traffic from the renderer.

## First deliverable acceptance

The runtime includes CEO idle turnarounds, work/phone poses and a simulated scene choreography. The loader supports frame files, FPS and finite/looping clips. Frame-by-frame raster walking, typing and seated transitions remain planned; 1,584 vector motion-study frames are kept separately and excluded from the default raster renderer. See [current delivery ledger](README.md).


## Registration workflow for production raster clips (#117)

Generated illustrations are **not** registered as motion clips until the artist has
produced real individual transparent frames. Keep original/approved source artwork
separate from the runtime. For a CEO forward walk:

1. Create `assets/animations/ceo/walk-front/00.png` through `05.png`,
   each 256×352 RGBA with consistent head, glasses, uniform and feet anchors.
2. Review all six frames at standard office zoom for alternate legs/arms and no
   scrolling background, mirrored face, false prop, or floor penetration.
3. Run `node scripts/register-office-clip.mjs ceo walk front 10`. This script
   inspects each file and creates a **prototype** manifest entry. A static image
   repeated six times is rejected. Explicit `--replace` is required to replace
   a pre-existing pose/clip mapping.
4. Run `npm run validate:assets && npm test && npm run build && npm run build:lib`.
   Validate the clip *inside the main office*, including rotation, fallback,
   reduced motion and replay (not only the visual showroom).
5. Record a GIF/MP4 of actual frame progression and seek owner approval before
   changing `status: prototype` to `status: approved`.

Other supported clip/facing combinations use
`assets/animations/<role>/<clip>-<facing>/<NN>.png`.
`walk` requires at least six frames; other true motion sequences require at
least two. FPS must be an integer in 1–24. Clip loops are defined centrally
in the registrar. The manifest's `frameFiles` remains the runtime source of
truth; the Vite loader imports only production PNG/WebP paths and deliberately
excludes `vector-study/` and `source/` originals.

**Current scope:** the loader, validation and import workflow exist; this does
not assert that new raster CEO walking/typing/sitting frames have been drawn.
