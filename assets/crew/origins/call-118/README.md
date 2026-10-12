# CEO phone animation originals

Issue #316, Refs #118 and #145. [Español](README.es.md).

Selected originals: `assets/crew/clips/ceo-call-pickup-v3.png` and `ceo-call-v1.png`, both **1254 x 1254 PNG RGBA**, generated with built-in `image_gen`. Exact prompts are stored here. Identity reference: `ceo-talk-v1.png`; pickup v3 edits v2, and the conversation atlas uses pickup v3 as reference. No pixel editing, mirroring or resizing was applied after generation. MIT repository artwork, status **prototype**.

Four rows (front/right/back/left), four phases per row: 32 new drawings. Pickup raises the phone from hip to ear over 800 ms. The conversation loop changes mouth and free hand over 1200 ms. Hangup reuses the pickup's four original crops in reverse order over 800 ms; it is not another sixteen new drawings. `calls.v1.json` records 12 clips / 48 frame references with source dimensions, hashes, prompt provenance, variant, FPS, loop, measured source rectangles, shoe anchors and constant reference height per facing. The logical presentation remains 256 x 352, anchor (0.5, 0.9375).

Rejected v1 switched hands in the last front frame and lost the phone in the left sequence. v2 corrected the front but retained the left defect. The targeted v3 edit redraws the near arm continuously in the left row. Both rejected originals and exact prompts remain here, excluded from runtime. Each profile uses the visible near hand/ear; anatomical handedness is not preserved when switching between the two profiles. No direction was created by reflection. Minor silhouette differences and four-phase timing remain prototype limits; this is not final cross-camera art approval.

See [runtime evidence](../../../../docs/crew/evidence/call-316/README.md).
