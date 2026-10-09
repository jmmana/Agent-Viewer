# Crew visual style contract

Issue: [#116 \[CREW\]\[VIS-02\] Crew visual style and independent art contract](https://github.com/jmmana/Agent-Viewer/issues/116), child of [Epic #114](https://github.com/jmmana/Agent-Viewer/issues/114).

This is a documentation deliverable only. It formalizes rules that already exist in code, in the approved reference sheet and in [ADR-001](../adr/ADR-001-crew-camera.md), so a future illustrator or engineer has one contract to target instead of reverse-engineering the CEO prototype. It does not add, edit or regenerate any art, does not change any runtime module, and does not promote any asset to `approved`.

## 1. Scope and authority

- Governs the **Crew** mode only: an original, illustrated "Office Beans" chibi style. It is not pixel art and it is not a reskin of the Among Us silhouette look. `Caricatura` (`src/engine/canvasRenderer.ts`, `src/components/OfficeCanvas.tsx`) is untouched and keeps its own, unrelated visuals; [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md) is the formal contract for that independence (Cartoon/Crew never import each other, a mode switch never recreates the domain store).
- Order of authority when documents disagree: **code and the asset manifest** (`assets/crew/asset-manifest.json`, `src/crew/*.ts`) are the ground truth; [ADR-001](../adr/ADR-001-crew-camera.md) is the architecture decision for camera/projection; [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md) is the two-mode independence contract; [FACING.md](FACING.md) is the canonical orientation math; this document is the style layer on top and must be corrected in the same PR if it ever drifts from what is actually implemented.
- Everything here assumes the independence rule from ADR-001: Crew never imports the legacy renderer, never reuses `renderFurnitureItem`, `GRID_ROWS`/`GRID_COLS` or `getOfficeRenderedBounds`, and a room shows only itself, never the full floor.

## 2. Reference material

The single approved style reference is [`assets/crew/references/ceo-approved-concept.png`](../../assets/crew/references/ceo-approved-concept.png) (1536x1024 PNG, manifest status `reference`, MIT, never modified in place). It is a concept sheet with these panels, which this contract treats as the origin of every rule below:

- **Character base**: front, left-profile, back, right-profile turnaround.
- **Facial expressions**: a 2x5 grid (neutral, focused, happy, thinking, worried, confused, explaining, approving, blocked/stressed, talking).
- **Walk cycle**: four directions (down/up/left/right in the sheet's own 2D convention), 8 frames each.
- **Work and interaction poses**: sitting, working on a laptop, standing up, talking, thinking, phone call, in a meeting, presenting, drinking coffee, celebrating.
- **Props and accessories**: laptop, smartphone, branded coffee mug, clipboard and pen, glasses, lanyard badge labelled "CEO".
- **Color palette (CEO)**: six named, hex-coded swatches (section 6).
- **Icons and effects**: speech bubble, thought cloud, lightbulb, check, alert, phone, wifi, bar chart, calendar, document.
- **Scale and reference** panel.

**Known discrepancy, recorded rather than hidden:** the concept sheet's own "scale and reference" panel labels the character at 48 px tall by 32 px wide. The runtime that was actually built and tested uses different, larger numbers (section 4). This contract treats the **implemented** values as authoritative, because they are the ones `asset-manifest.json`, `crewSprites.ts` and the automated tests actually enforce today; the sheet's 48x32 note is kept only as historical context on the concept image, not as a target for new art.

## 3. Asset lifecycle states

The issue asks for a `reference | vector-study | prototype | approved` lifecycle. Two of those four already exist as enforced manifest values; the other two are named and scoped here so the next issue that touches them does not have to invent the vocabulary.

| State | Meaning | Where it lives today | Enforcement |
| --- | --- | --- | --- |
| `reference` | Style/identity source. Exactly one per character line unless a future ADR-level decision supersedes it (as a new id, e.g. `reference.ceo.v2`; never an edit in place). | `assets/crew/references/ceo-approved-concept.png`, manifest `reference` entry. | `scripts/crew-assets.mjs` requires `status: 'reference'` and the exact recorded hash. |
| `vector-study` | The 1,584 SVG technical studies migrated from PR #43 (`assets/characters/*/vector-study/**`). Explicitly **excluded** from `asset-manifest.json` and from the Crew runtime. Useful only as line-work/proportion study material for illustrators; never citable as proof of an approved pose or animation. | Outside `assets/crew/`, documented in [ASSET-MIGRATION-PR43.md](ASSET-MIGRATION-PR43.md). | No manifest entry exists or should exist for these; they are deliberately kept out. |
| `prototype` | Current state of all 53 bank assets plus the reference (54/54). Safe to wire into engineering (sprite loading, camera projection, animation controller plumbing) but never presented as final art without the "not final" labelling ADR-001 requires for placeholders. | `assets/crew/asset-manifest.json`, every asset entry. | `npm run crew:assets:check` (hash, dimensions, duplicate id/file, license, no invented animation/perspective claim). |
| `approved` | Not reachable yet. An asset becomes `approved` only after (a) a visual review against this contract's silhouette/palette/proportion rules for its role, (b) a PR that flips its manifest `status` with the reviewer noted in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), and (c) for characters, all four facings present and passing the identity check in section 5. | Not yet used anywhere. | `scripts/crew-assets.mjs` currently **rejects** any non-reference `status` other than `prototype` ("La migración no aprueba arte automáticamente"). Wiring the first real `approved` asset needs a follow-up change to that validator; this is out of scope for this document (section 13). |

## 4. Character canvas, proportions and the chibi standard

Every one of the 11 character prototypes in the bank (`ceo` x6 poses, `analyst`, `developer`, `finance`, `planner`, `reviewer` x1 pose each) already agrees on the same canvas, confirmed directly from `asset-manifest.json`:

- **Runtime raster**: exactly **256x352 px**, RGBA PNG with a real alpha channel (`scripts/crew-assets.mjs` rejects any PNG color type outside `{4, 6}`, i.e. alpha is mandatory).
- **Logical size**: 64x88 world units, recorded in the manifest as historical sizing metadata. Per [`assets/crew/README.md`](../../assets/crew/README.md), this value does **not** drive collision or scale in the Crew spatial model (`CREW_PROP_SIZE` in `crewSpatial.ts` owns that); treat it as inherited bookkeeping, not a spatial contract.
- **Anchor**: exactly **(0.5, 0.9375)**, normalized to the canvas, i.e. the character's feet sit at 50% width / 93.75% height. This is a real, enforced runtime value (`CREW_CEO_SPRITE.anchor` in `src/crew/crewSprites.ts`), not a suggestion.
- **This contract makes both the 256x352 canvas and the (0.5, 0.9375) anchor binding for every future character pose or facing**, independent of the historical-metadata caveat above, which only disclaims the *logical size* for spatial purposes, not the raster canvas or anchor convention. `scripts/crew-assets.mjs`'s `validateCrewAssets` now enforces this for every `kind: 'character'` entry (`CREW_CHARACTER_CANVAS`, `CREW_CHARACTER_ANCHOR`), covered by `tests/crew-assets.test.mjs`.
- **Presentation height in a room**: 76 local scene units (`CREW_CEO_SPRITE.displayHeight`). This is a renderer constant illustrators do not control; art only needs to be correct at the 256x352 canvas regardless of the in-scene scale the camera later applies.
- **Chibi proportions** (visually confirmed against the approved reference): oversized head relative to the body, rounded features, thick black rounded glasses on every role, a visible full body with legs and shoes (never a floating-torso or capsule-body look), corporate attire appropriate to the role, and a lanyard badge worn at chest height.
- **No faking a missing facing.** ADR-001 names this explicitly as a prohibited option ("Option D", rejected) and the issue repeats it: never stretch, skew or horizontally mirror one facing's art to stand in for another. A missing view either ships as a separately, genuinely drawn asset, or stays a labelled "not available" placeholder (`artAvailability: 'missing'` in `CrewViewDefinition`). `crewSpriteView()` already only resolves a view when real art exists for it; it never derives one facing from another.

## 5. The four camera facings and identity consistency

- Facings are **front / right / back / left** (`CrewView`), each a separate, fully illustrated frame, never a rotation of one piece of art (ADR-001 section 2).
- The domain-to-camera mapping is owned by [FACING.md](FACING.md) and implemented in `crewSprites.ts` (`SPRITE_FACINGS`); this contract cross-references it instead of duplicating it, with one reminder for illustrators: the camera label identifies the **room's viewing angle**, not the character's own facing, so a character's `front` art can appear on screen under a `left` or `right` camera depending on which way that character is actually facing in the scene.
- **Identity rule.** The same character must stay recognizable at a glance across all four facings: same hairstyle silhouette, same glasses, same jacket color and cut, same badge, same prop in hand (if any), same skin tone. This is exactly what the CEO four-view evidence (`docs/crew/evidence/ceo-118/*.png`) and the dedicated manifest test (`tests/crew-assets.test.mjs`, "el piloto CEO conserva dimensiones y anclaje...") exist to protect. A PR adding a new facing for any role must include a comparable side-by-side contact sheet.
- Today only `ceo` has all four facings (plus two extra poses, `phone-front` and `work-front`); the other five roles (`analyst`, `developer`, `finance`, `planner`, `reviewer`) have a single `idle-front` prototype each. Filling in their remaining facings must follow this same identity rule and canvas contract before any of them can be considered for `approved`.

## 6. The six roles: silhouette and palette cards

All six roles share one system (chibi head, glasses, lanyard badge, corporate dress code) and differ on exactly two deliberate variables: **outerwear color/cut** and **the prop in hand**, which is also the functional cue of what that role does. Palette values below for the five non-CEO roles were measured automatically from the existing `idle-front` prototype PNGs (16-level color quantization, alpha ≥ 200, low-saturation/near-neutral pixels excluded to skip background, skin and line art); they describe what is already drawn, not an art director's ratified spec (see section 13). The CEO's palette is instead the one **authored on the approved reference sheet itself** and should be treated as settled.

| Role | Status today | Outerwear (silhouette cue) | Measured/authored swatch | Prop in hand | Notes |
| --- | --- | --- | --- | --- | --- |
| `ceo` | `prototype`, 4 facings + 2 extra poses | Single-breasted navy blazer, tie | `#1E3A84` (Azul oscuro), accent `#2563EB` (Azul corporativo), authored | Phone / laptop; badge "CEO" | Longest torso proportion of the six; only role with a full concept sheet |
| `analyst` | `prototype`, `idle-front` only | Teal blazer, tie | ~`#005060` (measured, unratified) | Tablet showing a bar chart | Lightest hair tone of the six in the current prototype |
| `developer` | `prototype`, `idle-front` only | Bright blue casual jacket with contrasting light-blue cuffs | ~`#1040C0` (measured, unratified) | Laptop under one arm | Only role in a casual jacket rather than a blazer or vest |
| `finance` | `prototype`, `idle-front` only | Dark teal/forest waistcoat (vest) over shirt and tie, no outer jacket | ~`#203030` (measured, unratified) | Handheld calculator / POS device | Buttons visible on the vest; no lapels |
| `planner` | `prototype`, `idle-front` only | Indigo/purple blazer | ~`#402080` (measured, unratified) | Clipboard with a checklist | Lighter blue tie than the blazer |
| `reviewer` | `prototype`, `idle-front` only | Rust/terracotta blazer, open over a white shirt and black tie | ~`#C05030` (measured, unratified) | Clipboard | Warmest hue of the six |

Shared, cross-role values:

- **Skin tone**: `#FAD7C4` (authored "Piel" swatch on the CEO reference). The five other roles' prototypes measure into the same warm family (`#F0C090`/`#F0D0A0` quantized buckets); adopt `#FAD7C4` as the canonical target.
- **Hair/outline**: a dark brown family (`#201010`-`#402020` measured range) across every role in the current art.
- **Glasses**: thick, rounded, black, on every role without exception. This is the single strongest shared silhouette cue that reads as "this is a Crew character" at a glance.
- **Badge**: a rounded-rectangle lanyard badge with a letter/icon, worn centered at chest height, present on every role.
- **Neutrals** from the CEO reference, usable as shared UI/background neutrals when needed: `#374151` (Gris grafito), `#F8FAFC` (Blanco roto).

## 7. Props, furniture, electronics and effects: naming convention

- File layout: `assets/crew/bank/{characters,furniture,electronics,effects}/<slug>.{png,svg}`.
- Manifest id pattern: `character.<role>.<clip>.<facing>` for characters (e.g. `character.ceo.idle.front`); `<kind>.<slug>` for everything else (e.g. `furniture.desk-executive`, `electronics.dual-monitor`, `effect.wifi`).
- Per ADR-001's asset-by-camera matrix, furniture and electronics are expected to eventually ship per-facing variants (front/right/back/left) sharing one hitbox/anchor. Until that art exists, `renderCrewRoom.ts` draws placeholder geometric boxes (the `color` map inside that file: desk/chair/plant/screen fills). **Those placeholder colors are not final art** and must never be screenshotted or referenced in an acceptance doc as approved furniture.
- Screens (monitor, laptop, TV) never render mirrored text or characters. From a facing where the screen face is not visible, show the physical casing/back/profile only (ADR-001, "Pantallas y televisor" row).
- Effects (`alert`, `blocked`, `call`, `check`, `sync`, `terminal`, `thought`, `tool`, `wifi`) render only in response to a real `LIVE` event or an explicitly labelled `DEMO` scene; they are never decorative ambience (ADR-001 section 5, point 7, and the issue's own rule on empty rooms).

## 8. Animation and clip contract

The only shipped clip, `ceo.blink.front.v1` (`src/crew/crewAnimation.ts`), is the reference implementation this section formalizes:

- **Clip id pattern**: `<role>.<clip-name>.<facing>.v<version>`.
- A clip is an **atlas** (PNG/WebP RGBA) with an explicit `frames` array. Each frame has a pixel rectangle (`x, y, width, height`), a per-frame `anchor` measured in **atlas pixel space** (not the normalized 0..1 anchor used for a static pose) on that specific frame's opaque foot pixels (this corrects for generation drift between cells without touching pixels), and a `durationMs`. All of this is validated by `validateCrewClip()`: integer rectangles inside atlas bounds, positive duration, anchor inside the frame's own bounds.
- A static pose (`frames: 1, fps: 0, loop: false` in the manifest) is never an approved "clip". A clip only counts as genuinely animated once it has 2+ visually distinct frames. For a walk cycle specifically, the issue's acceptance bar is **at least 6 distinct frames per direction**; the approved reference sheet itself already draws **8 frames per walking direction**, and this contract adopts 8 as the real target, not 6, so future art does not regress below what was already designed and approved.
- `loop: true` is for idle/ambient gestures (blink, breathing); `loop: false` is for one-shot reactions (celebrating, answering a call) that must return to an idle clip afterward. `crewClipSample()` already encodes this: a non-looping clip past its last frame returns `{ index: last, nextInMs: null }` and schedules nothing further.
- **Reduced motion**: every clip must have a presentable "resting" frame at index 0, because `crewClipSample(..., reducedMotion=true)` always returns `{ index: 0, nextInMs: null }`: that is the only frame a reduced-motion viewer, or a viewer whose atlas failed to load, will ever see.
- **Hidden tab**: the existing blink controller pauses its clock while the tab is hidden and resumes from the "eyes open" frame. Any new clip's frame 0 must be a safe resume point for the same reason.
- A pose study, a single illustrated frame, or a vector study is never citable as proof that a clip is "animated" (this repeats the explicit wording already used in `assets/crew/README.md` and `IMPLEMENTATION-STATUS.md`; this contract does not relax it).

## 9. Layer order and camera projection (reference only, owned by code)

This section is not new policy; it restates ADR-001 section 3 and `renderCrewRoom.ts` so an illustrator knows what the engine already guarantees around their art:

- Draw order: floor → back walls → back furniture → actors/props depth-sorted by local `(x + y)` → front furniture → lights/particles → HUD. The front wall is cut away for interior visibility; it is not missing art, it is a deliberate rendering choice.
- Projection is `oblique-2_5d` (ADR-001's `CrewViewDefinition.projection`), a fixed, discrete, per-view pseudo-isometric projection, not a free 3D camera. Illustrators need to know only which silhouette edge faces the "camera" for a given facing; compositing order is owned by the engine, not by the art files.

## 10. Accessibility and zoom range

- Camera zoom is clamped to **[0.5, 3]** in code (`crewCamera.ts`: `zoomCrewCameraAt`, `validateCrewCamera`). Art must read clearly at both ends: no fine detail that disappears below 0.5x, no visible pixelation or banding that becomes objectionable at 3x when a 256x352 PNG is scaled up through the canvas. Preview new art at both extremes before marking it `approved`.
- Keyboard and touch camera controls themselves are out of this document's scope (owned by #156/#171); this contract binds only the art, not the input handling.

## 11. Licensing and provenance ledger

- Every bank asset already carries `license`, `provenance`, `sourceCommit` and `sha256`, enforced by `validateCrewAssets()`. A newly illustrator-provided asset must carry the same fields (with `sourceCommit`/`provenance` describing its real new origin instead of PR #43's commit) so the existing validator keeps working without a schema break.
- `reference.*` assets are never modified in place. A revised concept ships as a new id (for example `reference.ceo.v2`), so old evidence screenshots and PRs that cited the previous reference remain valid and auditable.

## 12. What this document explicitly does not do

- It does not add, edit or regenerate any PNG, SVG or WebP asset.
- It does not change `asset-manifest.json`'s data, `crewSprites.ts`, `crewAnimation.ts`, `renderCrewRoom.ts` or any other runtime module beyond the validator addition in section 4 (which encodes an already-true invariant, it does not change today's art or data).
- It does not promote any asset's `status` to `approved`.
- It does not block or redefine CREW-001..008 foundational work; it exists so illustrators have one contract to target before the first non-CEO facing or clip ships, instead of reverse-engineering the CEO prototype by hand.

## 13. Open follow-ups (explicitly out of scope here)

- Wiring an `approved` status transition into `scripts/crew-assets.mjs` once a future issue actually promotes a real asset.
- A formal `vector-study` manifest classification, if the 1,584 PR #43 SVGs are ever catalogued instead of being deliberately excluded as they are today.
- Art-director ratification of the five non-CEO roles' palettes; today's swatches in section 6 are measured from existing prototype art, not an authored decision like the CEO's.
- Per-facing furniture and electronics art, to replace the placeholder geometric boxes `renderCrewRoom.ts` draws today.
