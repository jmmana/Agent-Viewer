# CEO desktop runtime (Refs #118)

The fixture `tests/e2e/fixtures/crew-desktop.html` mounts the real CrewStage with explicit DEMO and immutable synthetic snapshots. CODING/WRITING enters sit then typing, leaving that activity plays stand, and a reported facing change plays turn. This is a presentation interpretation of observed work status, not evidence of a physical person sitting or typing. Live snapshots, events and usage are never modified.

Reproduce on isolated port 3118:

```sh
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config playwright.crew118.config.ts
```

The four camera screenshots and runtime MP4 are captured from this test. It checks actual source rectangles for all four actions, distinct actor orientations, fallback EN/ES, reduced motion and scene exit. Full-frame character originals live in `assets/crew/clips/ceo-{sit,stand,typing}-v1.png` and `ceo-turn-v2.png`; provenance is in `assets/crew/origins/desktop-118/`.

Prototype limits: generated proportions/alpha speckles; discrete four-direction camera projection; geometric chair and the existing billboard desk without final four-view furniture art. A chair is placed nearer its desk only in the scene's presentation while occupied. Actor transitions do not implement physical approach trajectories or anti-foot-slide. Delayed/failed images retain the static sprite. No final art approval or complete CEO acceptance is claimed.

Still pending in #118: call, talk, think, approve, review, blocked, celebrate, coffee/drink, stretch/dance, final art and full choreography/physical navigation acceptance. Walk/blink were delivered previously. This PR uses Refs #118 and leaves it open.

The existing desk billboard does not align the typing hands with its surface in every camera. This remaining furniture/actor fit is explicitly not certified by this delivery.
