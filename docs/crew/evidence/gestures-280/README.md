# CEO gesture runtime evidence

Issue #280, Refs #118. [Español](README.es.md).

[runtime.mp4](runtime.mp4) records the actual `CrewStage`, with an explicit DEMO label and synthetic frozen snapshots. Twelve PNGs show think/talk/review under front/right/back/left cameras. Camera names are not actor facings: for the SE actor they map to front/left/back/right art. Each camera explicitly focuses the actor so all four views remain visible.

Reproduce with `npx playwright test -c playwright.crew118.config.ts tests/e2e/crew-gestures.spec.ts --workers=1`. The test records video and checks all four source rectangles of each clip in each camera, unchanged source snapshot, no browser errors, state/room cancellation, reduced motion and English/Spanish missing-image fallback. The existing desktop fixture is reused, not a substitute renderer. Convert its `video.webm` with `ffmpeg -i video.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime.mp4`.

Only THINKING, CHATTING and REVIEWING select these gestures. READING, USING_TOOL and IN_MEETING do not imply them. Walking cancels them; standing/turning completes before the requested gesture begins. Existing hidden-tab pause and lazy image cancellation are retained. No private reasoning, events, metrics or usage are generated or changed.

Artwork remains prototype, with small silhouette differences and four-phase timing. Furniture and physical navigation are outside this delivery. #118 remains open for call, approve, blocked, celebrate, coffee/drink, stretch/dance and final art/choreography acceptance. See [originals and metadata](../../../../assets/crew/origins/gestures-118/README.md).
