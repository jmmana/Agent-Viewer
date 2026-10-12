# CEO pickup, conversation and hangup

Issue #316, Refs #118 and #145. [Español](README.es.md).

[Runtime MP4](runtime.mp4) shows the real CrewStage in an isolated CEO room, with labelled synthetic DEMO data. Four PNGs show the camera views; the actor's SE facing maps front/right/back/left cameras to front/left/back/right artwork. `call-mobile-reduced.png` shows the neutral fallback and call notice under reduced motion at 390 x 844.

Reproduce: `npx playwright test -c playwright.crew118.config.ts tests/e2e/crew-call-animation.spec.ts --workers=1`. The first test checks all four source crops in temporal order for pickup and reverse hangup, conversation frames in each orientation, and return to idle without continued drawing. The second covers two actors, room isolation, persistent reported call after returning, mobile/reduced motion, EN/ES failed-atlas fallback and unmount cleanup. Existing `crew-phone-call-145.spec.ts` supplies LIVE event, call notice and Caricatura regression coverage.

Only the reported `PHONE_CALL` state starts playback. Returning to IDLE/AVAILABLE lowers the handset before neutral; walking, another task or absence cancels it. These are local presentation phases, not real provider pickup/hangup timestamps or commands. Stand finishes before pickup; changing facing restarts local pickup after turn. Leaving the room discards local frames, never the host's call state. The existing notice/timeline and opt-in sound remain independent. Dismissing the notice does not terminate the call or its artwork. Reduced motion or missing frames retains neutral artwork and the existing notice. Neutral images are shared; phone frames belong only to the calling actor, preventing another CEO from inheriting a phone.

The PNGs remain prototype. Each profile uses the near hand/ear, so switching profiles does not preserve anatomical handedness. No physical paths, other roles, real connectivity or final art approval is delivered. #118 and #145 remain open for their remaining scope. [Originals, rejected versions and prompts](../../../../assets/crew/origins/call-118/README.md).
