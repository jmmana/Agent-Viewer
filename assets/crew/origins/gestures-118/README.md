# CEO think, talk and review originals

Issue #280, Refs #118. [Español](README.es.md).

Three original PNGs generated with built-in `image_gen`, using `assets/crew/clips/ceo-typing-v1.png` only as the identity/style reference. Exact prompts are preserved beside this file. Selected outputs are `assets/crew/clips/ceo-{think,talk,review}-v1.png`, each **1254 x 1254 RGBA**. No pixels were edited, resized, mirrored or synthesized after generation. Repository artwork license: MIT. Status: **prototype**, not final approval.

Each atlas contains four rows (front, right, back, left) with four independently drawn phases each. Thinking moves the hand at the chin and tilts the head; talking changes mouth and open-hand gestures; reviewing traces a clipboard and lifts a page. Rear gestures read through elbows/head and the document edge. Talking alternates the gesturing arm in the frontal middle phases. Small drawing/proportion differences remain; these are four-phase stylized cycles, not smooth motion capture.

`gestures.v1.json` follows the existing action catalog: actual dimensions, measured source rectangles and shoe anchors, SHA-256 for file/frame/prompt, variant, FPS, loop, logical 256 x 352 presentation and logical anchor (0.5, 0.9375). Transparent row gaps are measured per column. Constant `referenceHeight` per orientation prevents head tilt from rescaling the body. Each phase lasts 300 ms; loops last 1200 ms while the reported state remains active. No physical locomotion is introduced.

Runtime video and camera captures: [evidence](../../../../docs/crew/evidence/gestures-280/README.md).
