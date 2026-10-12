# Crew ambience #148 — runtime evidence

Captured from the real application with Playwright against branch
`feat/crew-room-ambience-148`, based on main `e531019`.

- [CEO at night](ceo-night.png): original window geometry and skyline in Crew.
- [Development at sunset](development-sunset.png): separate room setting, zoom/pan.
- [Mobile night / right camera](mobile-night.png): 390×844 viewport.
- [Runtime recording](runtime.mp4): desktop test, four views, room switch,
  Cartoon round-trip, reload and high contrast; converted from Playwright WebM.

Reproduce from the repository root:

```sh
npx playwright test tests/e2e/crew-ambience-148.spec.ts
```

Screenshots and WebM recordings are written beneath `test-results/crew-ambience-*`.
The desktop recording was converted without synthesizing frames:

```sh
ffmpeg -i test-results/crew-ambience-148-room-amb-85ea9-ameras-and-Cartoon-desktop-/video.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime.mp4
```

These captures verify runtime integration, not approval of final art or
physical-device accessibility certification. See [the feature contract](../../AMBIENCE.md).
