# CEO workstation fit evidence

Closes scope #276, Refs #118. The real CrewStage fixture preserves the existing 64 character frames and adds eight original desk/chair views with measured keyboard, seat and foot contacts. Keyboard position stays constant during typing; intentional chair/table occlusion follows the actor's orientation.

```sh
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config playwright.crew118.config.ts
```

`desktop-{front,right,back,left}.png` and `runtime.mp4` show sit, typing, stand and turn in the isolated CEO room. Zoom and mobile images come from `crew-workstation.spec.ts`. Synthetic input is visibly marked DEMO and remains read-only. Tests also cover unavailable prop art, reduced motion, empty rooms and the eight source rectangles.

Art remains prototype: hand alternation intentionally lifts fingers from the keys and source proportions vary slightly between views. Furniture changes are limited to the occupied CEO presentation, not a final furniture catalog or physical navigation. Other #118 actions remain pending; call is separately tracked by #145/PR #274. This delivery does not certify all of #118.
