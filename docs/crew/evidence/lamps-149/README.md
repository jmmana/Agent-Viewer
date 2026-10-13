# Crew lamps #149: runtime evidence

Captured from the real application with Playwright against branch
`feat/crew-lamps-149`.

- [CEO desk lamp on](ceo-desk-lamp-on.png): a real canvas click toggled only
  the desk lamp; ceiling and wall fixtures stay in Auto (off, day ambience).
- [CEO all lamps on](ceo-all-lamps-on.png): the room-wide **All: On** control
  lights every fixture at once; subtitles show each toggle.
- [CEO night, all Auto](ceo-night-auto.png): with no manual override, every
  fixture resolves to on from the Night ambience alone.
- [Runtime recording](runtime.mp4): canvas click, click-again cycle, keyboard
  toggle via the accessible button, room-wide On/Off, a drag that must never
  switch a light, room switch and Cartoon round-trip; converted from the
  Playwright WebM.

Reproduce from the repository root:

```sh
npx playwright test tests/e2e/crew-lamps-149.spec.ts
```

Screenshots and WebM recordings are written beneath `test-results/crew-lamps-*`.
The recording was converted without synthesizing frames:

```sh
ffmpeg -i "test-results/crew-lamps-149-clicking-a--15c1a-and-state-persists-per-room/video.webm" -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime.mp4
```

These captures verify runtime integration, not approval of final art or
physical-device accessibility certification. See [the feature contract](../../LAMPS.md).
