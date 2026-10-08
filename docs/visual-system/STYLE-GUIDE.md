# Agent Viewer Office Crew — Visual Style Guide (v1)

Status: initial visual contract, prototype phase. Canonical language: English for semantic identifiers, Spanish and English for presentation.

## Source and philosophy

Derived from the user's **Agent Viewer — Guía Maestra de Diseño Visual**. This guide specifies **Office Beans + Mini Executives**: rounded, friendly silhouettes with credible office clothing and expressive accessories, without copying recognizable third-party character designs. Desk Runners informs movement, not the base silhouette.

**This system is not pixel art.** Aim for an original premium corporate cartoon, smooth contours, softly shaded flat-color surfaces and clear hierarchy.

### Required design cues

- Soft compact capsule torso, readable head, expressive small arms, short **visible legs**.
- **Glasses** are the team signature. Distinguish roles by glasses shape as well as color, clothing and carried objects.
- Office/business-casual clothes; clean, nonmilitary silhouettes.
- Laptop, tablet, clipboard, pen, phone or cup may be held or put on furniture; limit a figure to **one primary plus one secondary prop**.
- **Never add helmet visor, oxygen pack, astronaut suit, backpack, borrowed logos or externally sourced character sprites.**
- Favor friendly expressiveness over exaggerated cartoon motion.
- The viewer visualizes actual agent events; illustrative ambient actions must be clearly marked simulated in showcase mode.

## Role palettes

| Role | Base colors | Distinction | Prop |
|---|---|---|---|
| CEO | Navy #1E3A8A / dark navy #1E293B / soft gold #F1C40F | Slim rectangular glasses, formal jacket, straight confident pose | Tablet/phone |
| Planner | Purple #7C3AED / blue #2563EB | Round glasses, smart blazer, communicative arms | Clipboard/tablet |
| Developer | Blue #2563EB / cyan #22D3EE | Modern rectangular glasses, business-casual tech outfit | Laptop |
| Analyst | Teal #0D9488 / green #16A34A | Larger glasses, observant posture | Analytics tablet |
| Reviewer | Amber #EA580C / muted red #DC6C62 | Thin glasses, controlled posture | Review clipboard |
| Finance | Dark green #166534 / charcoal #374151 | Classic glasses, formal layers | Cost tablet/calculator |

## Coordinate and sizing contract

The existing game engine draws a **24 × 16 rectangular office grid with 48 px square tiles** in Canvas2D, not a diamond/isometric tile map. Respect this geometry, camera rotation and entity depth sorting rather than redesigning room coordinates.

**Prototype baseline** (tune after in-app comparison):

- Logical canvas sprite frame: **64 × 88 px** at 1×. Body should occupy roughly 36–44 px wide and 60–72 px tall within the frame.
- Runtime PNG exports: **256 × 352 px** (4×) with transparent background. Original high-resolution generated sources are preserved separately and excluded from application bundles.
- Normal feet anchoring: `anchorX=0.5`, `anchorY=330/352`; anchor locates the ground contact point, not the center of the head.
- Preserve character scale across all poses and facing directions; choose a fixed bounding box.
- Facing IDs: `front`, `back`, `left`, `right`. These are **world-space orientations**, not image mirroring assumptions.
- Figure shadows should be composited by the runtime when possible to avoid a different shadow in each walk frame.
- Reference sheets are *art direction*, **not** production sprite sheets. Crop and separate assets only after visual QA.

## Visual system conventions

- Preserve source art at high resolution and only add optimized runtime exports to the application bundle.
- Props, furniture and electronics are distinct layers with transparent bounds; screens/TV text is runtime data, not baked-in image copy.
- Speech bubbles, event states, provider usage figures and UI labels are rendered by the product and localized using existing i18n; do not write text into character sprites.
- Room backgrounds must not obscure traversal, navigation slots, labels or other agents.
- Every runtime asset has a manifest entry and an explicit `prototype` or `approved` lifecycle state.
- Reduced motion is respected; meaningful state must remain discoverable without animations.
- Use original artwork made for Agent Viewer; track provenance/licensing before publishing.

## Initial acceptance gate

1. One recognizable CEO prototype with glasses, dark-blue blazer, gold accent, office device and short visible legs.
2. A working manifest entry pointing to a real repository file.
3. Preview at full zoom and at standard office zoom without losing role identity.
4. Correct feet anchor, no floor penetration, no label overlap, no extra props beyond the limit.
5. Next phase only after we can load and render a sprite without mutating operational agent state.
