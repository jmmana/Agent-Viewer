# CEO workstation fit, #276 (child of #118)

Built-in `image_gen`, exact prompts preserved alongside the rejected v1. Selected original: `assets/crew/props/ceo-workstation-v2.png`, 1024 x 1536 RGBA, copied unchanged. MIT, prototype, no final art approval. Reference: the existing CEO typing atlas. No character frame was regenerated or edited.

v1 repeated frontal desks for both profiles. v2 corrects the desk sides and preserves distinct chair views. The image viewer displays colored RGB beneath alpha zero; direct pixel inspection and the browser confirm real transparency. No background-removal filter or pixel edits were applied.

`assets/crew/props/workstation.v1.json` records dimensions, eight measured source rectangles, keyboard/seat contacts, source/prompt/frame SHA-256 and provenance. Runtime uses explicit foot/contact calibration per view, uniformly scaling each furniture part, never reflecting it. Table and chair stay fixed across animation frames.

Only an occupied CEO workstation with loaded character/action/prop images uses the layered fit. Front: chair, actor, desk, upper actor over keyboard. Profiles: chair, desk, actor. Back: desk, actor, chair. Missing art, reduced motion and other rooms retain existing presentation. No domain coordinates or room furniture definitions are modified.
