# Crew agent navigation #129: runtime evidence

Captured from the real application with Playwright against branch
`feat/crew-navigation-129`, driving the existing `crew-walk` fixture with the
single CEO agent placed in `development` (`?workspace=development`).

- [Resting](resting.png): idle at the hash-assigned slot (8.75, 2.75), no
  walk-cycle sprite drawn.
- [Walk start](walk-start.png): just after `isWalking` flips true, near the
  resting slot.
- [Walk midpoint](walk-midpoint.png): partway along the real path, already
  past the first desk/chair pair, confirming the route bends around furniture
  instead of cutting through it.
- [Arrived](arrived.png): settled at the room's door (0.75, 9.25), the
  Development room's only arrival point.
- [Runtime recording](runtime.mp4): the full walk start-to-finish, plus the
  cancellation case (toggling back to resting mid-flight); converted from the
  Playwright WebM.

Reproduce from the repository root:

```sh
npx playwright test tests/e2e/crew-agent-navigation-129.spec.ts
```

Screenshots and WebM recordings are written beneath
`test-results/crew-agent-navigation-129-*`. The recording was converted
without synthesizing frames:

```sh
ffmpeg -i "test-results/crew-agent-navigation-129--466db-ons-instead-of-a-fixed-spot/video.webm" -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime.mp4
```

These captures verify runtime integration, not approval of final art or
physical-device accessibility certification. See
[the feature contract](../../NAVIGATION.md).
