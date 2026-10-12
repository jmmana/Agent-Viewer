# Crew character editor #127: wiring evidence

Captured from the real application with Playwright against the existing
`crew-walk` fixture (the same one `tests/e2e/crew-walk.spec.ts` and
`tests/e2e/crew-agent-navigation-129.spec.ts` already drive).

- [Open panel](open-panel.png): the appearance panel opened for the fixture
  CEO, showing all six categories (Character, Hairstyle, Skin tone,
  Clothing, Footwear, Accessory), the 4-side placeholder preview, and the
  existing agent list button still present alongside it.

Reproduce from the repository root:

```sh
npx playwright test tests/e2e/crew-character-editor-127.spec.ts
```

This confirms the editor tool (already fully unit tested in
`tests/lib/crewCharacterEditor127.test.tsx`) is now reachable from the real
`CrewStage` tree, that a change persists per `agentId` across a reload, that
reset returns to the role's documented default, and that two agents never
share an appearance. It does not certify Epic #114 G1 and does not claim the
cosmetic choice changes which sprite the scene draws: that connection stays
blocked on real, multi-role art from #125/#126. See
[the feature's own test file](../../../tests/lib/crewCharacterEditor127.test.tsx)
for the full data-layer contract.
