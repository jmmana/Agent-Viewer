# Crew frame pipeline

Issue [#117](https://github.com/jmmana/Agent-Viewer/issues/117). This pipeline belongs exclusively to the independent Crew renderer. It does not import the Cartoon canvas or its historical clip tools.

The CEO pilot has four original walk atlases, each with eight illustrated phases at 8 FPS. The selected assets remain `prototype`; visual inspection accepted identity and changing limbs for this engineering pilot, not final art or the wider CEO animation acceptance in #118. Physical paths and locomotion belong to #129. Playback reads `Agent.isWalking` and facing from the existing snapshot; it never changes agent position, events, tasks or usage.

## Sources, catalog and runtime

| Layer | Location and purpose |
| --- | --- |
| References | `assets/crew/references/ceo-approved-concept.png` and the four original bank poses, preserved byte for byte. |
| Origin and rejected study | `assets/crew/origins/walk-117/`: exact prompts and the rejected left v1. Its second row repeated a half cycle; it is never imported by the runtime. |
| Selected original atlases | `assets/crew/clips/ceo-walk-*.png`: built-in `image_gen` outputs copied without pixel edits, resizing, mirroring or rotation. |
| Versioned catalog | `assets/crew/clips/manifest.v1.json`: canonical metadata and measured source rectangles. |
| Runtime | `crewWalkRegistry.ts`, `useCrewWalk.ts`, `crewSpriteLayer.ts` and the existing `CrewStage`/`renderCrewRoom` orchestrator. |

The manifest records `schemaVersion`, id `<role>.<clip>.<facing>.v<version>`, role, variant, clip, facing, raster dimensions, logical resolution, FPS, normalized logical anchor, loop, per-frame pixel anchors/durations/order/hash, license, source commit, reference, exact prompt file/hash, atlas hash and prototype visual review notes. Exactly one active clip per facing is required. This pilot registry deliberately supports only `ceo/default/walk`.

| Facing | Original PNG | Actual size | Source rectangles |
| --- | --- | --- | --- |
| front | `ceo-walk-front-v1.png` | 1512×1040 | Four columns, 492 px frame height, rows at y=0/492. |
| right | `ceo-walk-right-v1.png` | 1513×1040 | Four measured integer columns, 510 px frame height, rows at y=0/510. |
| back | `ceo-walk-back-v1.png` | 1513×1039 | Four measured integer columns, 510 px frame height, rows at y=0/510. |
| left | `ceo-walk-left-v2.png` | 1470×1070 | Four measured integer columns, 527 px frame height, rows at y=0/527. |

These atlases are **not** 256×352 PNG poses. Their logical presentation contract remains 256×352 with anchor (0.5, 0.9375); source-frame anchors are explicit pixel measurements and presentation height stays 76 scene units. Row boundaries were inspected on decoded alpha to avoid capturing the next row's hair. The x anchor centers each silhouette; y is the measured lowest opaque shoe pixel plus one. There is no image processing or simulated pose translation. Natural limb movement remains visible; scale/width differences between generated drawings and minor alpha speckles remain known prototype limits.

## Safe import and integrity

```sh
node scripts/crew-clip-assets.mjs check
node scripts/crew-clip-assets.mjs import /path/to/candidate.json
```

Import coerces all entries to `prototype`, validates before writing, refuses to replace an existing differing catalog, and writes atomically. An identical import is idempotent. Approval needs a separate human visual review and explicit catalog change; this importer cannot grant it. The inspector decodes PNG only for validation, never editing it. It checks RGBA, real transparent and opaque pixels in every frame, atlas/frame/prompt hashes, rectangles, duration, anchors, four unique facings and duplicate IDs/files/content. Safe paths stay within the repository even through symlinks. Frame hashes prove integrity, not motion quality: the actual drawings and runtime evidence were inspected separately.

## Runtime behavior

Only illustrated CEO markers in the selected room that report `isWalking` request walk assets. The existing domain-camera facing mapping selects the genuine orientation without reflection. Each required facing loads once per mounted scene. Camera selection preloads only its chosen module; the static original remains visible until the corresponding PNG loads. Failed or dimensionally wrong atlases retain the original sprite with a localized EN/ES notice.

A single presentation clock samples explicit 125 ms durations. Reduced motion, including system preference, retains the original pose and skips atlas downloads. Hidden tabs stop the clock and resume at frame 0. Switching room, facing, mode or unmounting cancels image callbacks and timers; stale callbacks cannot populate the current scene. There is no global image cache or store mutation. This reproduces reported transit **in place at the snapshot's existing Crew position** until #129 supplies real trajectories; it does not claim anti-foot-slide validation.

## Reproducible evidence

`tests/e2e/fixtures/crew-walk.html` mounts the real `CrewStage` with frozen synthetic input and a visible localized DEMO label. It is a test fixture, not a substitute renderer or production control. `tests/e2e/crew-walk.spec.ts` checks all eight source rectangles in four camera views, unchanged input, role/room gating, fallback, mobile Spanish, zoom 3 and reduced motion. Existing Cartoon and mode-switch E2E remain part of the full browser suite.

The PNG previews and [runtime MP4](evidence/walk-117/runtime.mp4) live in `evidence/walk-117/`. Camera and actor facing are distinct: camera front/right/back/left projects the default domain-facing SE into sprite front/left/back/right. The capture names identify the **sprite** direction. Recording uses Chrome on isolated port 3117, no external service, no real data. Prototype props remain geometric blocks; this evidence does not certify G1, other roles, final rooms, or the additional actions in #118.

## Final validation

Validated on main `5560b2c`: 1,051 Node tests passed (one skipped), 740 Vitest, 29 Python and 29 Chrome E2E tests passed. Typecheck, production audit, app/library/CLI builds, package checks and golden reconciliation passed. The full suite ran once; a fixture enum typo was corrected and only typecheck repeated before browser execution. Existing SSE/log replay and Cartoon regression suites passed; the new pure renderer test confirms that event-prefix replay and full snapshots retain events and usage. No private provider data is used.

## Desktop extension (Refs #118)

`actions.v1.json` registers 16 prototype clips / 64 original frames for turn, sit, stand and typing. It preserves the walk metadata pattern without changing the walk-only importer. Actual atlas sizes, prompts and rejected turn v1 are documented in `assets/crew/origins/desktop-118/README.md`. Per-frame `referenceHeight` preserves common body scale when sitting; actual crop height remains independent. `crew-desktop-assets.test.mjs` verifies source/frame/prompt hashes, dimensions and alpha. See [runtime evidence and limitations](evidence/desktop-118/README.md).
