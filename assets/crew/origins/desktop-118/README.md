# CEO desktop originals (Refs #118)

Generated with the built-in `image_gen` tool from the preserved CEO concept reference. Exact prompts accompany the original PNGs; no pixels were edited, reflected, resized or synthesized by the importer. Art is distributed under this repository's MIT license and remains **prototype**, not approved final art.

- `ceo-sit-v1.png`, `ceo-stand-v1.png`: 1070 x 1470 RGBA.
- `ceo-typing-v1.png`: 1195 x 1316 RGBA, supporting reference was the sit atlas.
- `ceo-turn-v2.png`: 1038 x 1515 RGBA. v1 is preserved here but rejected because row 3 began facing left and row 4 ended facing right. v2 redraws those direction errors.

Selected originals are in `assets/crew/clips/`. Four rows represent front/right/back/left; four columns represent consecutive phases. Turn rows end at that orientation and begin at the preceding orientation in the sequence front/right/back/left. Opposite turns reverse frame order; 180-degree turns concatenate two quarter turns. No image reflection is used.

`actions.v1.json` preserves actual dimensions, explicit source rectangles, foot anchors, source/prompt/frame SHA-256, variant, FPS, loop, logical 256 x 352 presentation and normalized logical anchor. `referenceHeight` gives a common source-pixel presentation scale: seated frames must not be enlarged to standing height. Source row boundaries were measured in transparent gaps, not inferred as equal quarters of image height. Feet centers use the bottom 18 opaque pixel rows. Originals include minor alpha speckles and drawing/proportion differences; reduced motion keeps static poses.

Runtime evidence and remaining limitations: `docs/crew/evidence/desktop-118/README.md`.
