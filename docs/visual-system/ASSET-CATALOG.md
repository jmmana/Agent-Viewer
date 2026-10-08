# Visual Assets — Integration Catalog

## Source of truth

The machine-readable registry is `assets/asset-manifest.json`.

Only entries whose `file` actually exists may be registered. Planned characters, poses, rooms, furniture and effects belong in planning documentation, not as false-positive playable assets.

### Directory policy

```text
assets/
  asset-manifest.json
  characters/<role>/<clip>-<facing>.svg
  characters/<role>/<clip>-<facing>.png
  animations/<role>/<clip>-<facing>.webp
  furniture/<object>.svg
  electronics/<object>.svg
  effects/<effect>.svg
  rooms/<room>/<piece>.svg
```

SVG may be used for vector prototypes and simple props; final dense body animation sheets should be PNG/WebP plus timing metadata. Image **concept sheets are reference documents**, not code-loadable runtime sprites.

### Manifest record

- `id`: immutable dotted identifier.
- `kind`: character, furniture, electronics, room, effect.
- `file`: relative repository path to the real asset.
- `status`: prototype or approved.
- `role`, `clip`, `facing` for characters.
- `logicalSize`: drawn pixel size in the 48px tile grid.
- `anchor`: normalized foot contact fraction.
- `license`: original Agent Viewer art, MIT for committed code/assets unless later separately documented.

### Acceptance QA

1. File resolves; correct SVG/PNG/WebP and no external IP or third-party marks.
2. Full-alpha edges/transparent background, no lettering baked into sprite.
3. Visible at standard zoom without losing hands, glasses or role palette.
4. Same geometry and perspective between frames and mirrored/rotated office camera.
5. Does not overlap name labels, speech bubble safe area or neighbors.
6. No movement through obstacles; room navigation remains authoritative.
7. Cost, tokens, provider labels and social dialogue are runtime data, never decorative content.
8. File provenance and lifecycle state remain documented.

### Current delivery status

`character.ceo.idle.front` now points to the reference-derived PNG. The legacy engineering SVG is preserved but excluded from the runtime catalog. The original approved sheet is archived as a style reference; it is not a production atlas. The runtime catalog includes 11 transparent character poses and 42 environment resources. The separate character catalog includes vector motion studies that must not replace these PNGs. See [current delivery ledger](README.md).
