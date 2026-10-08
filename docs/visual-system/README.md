# Agent Viewer Office Crew — Visual System

> **Implementation phase:** first character prototype; not yet integrated with the Canvas2D runtime.

This directory hosts the production design contracts for the original visual assets created for Agent Viewer.

## Canonical documents

- [MASTER-DESIGN-GUIDE.es.md](MASTER-DESIGN-GUIDE.es.md) — full user-approved original Spanish art direction (six roles, offices, objects, motions, effects).
- [STYLE-GUIDE.md](STYLE-GUIDE.md) — geometry, sizes, palette and originality contract.
- [CHARACTERS.md](CHARACTERS.md) — six differentiated Office Crew roles and the CEO pilot.
- [ANIMATIONS.md](ANIMATIONS.md) — frame and motion rules, mapping from observed runtime events.
- [ASSET-CATALOG.md](ASSET-CATALOG.md) — naming, packaging, metadata and quality gates.

## Pilot resource

- [CEO front-facing idle prototype](../../assets/characters/ceo/idle-front.svg) — original SVG vector test.
- [Asset registry](../../assets/asset-manifest.json) — includes precisely one **prototype** entry for the SVG above.

Run `node scripts/validate-visual-assets.mjs` at repository root to verify manifest metadata and files exist.

## Delivery ledger

| Deliverable | Status |
|---|---|
| Approved source requirements imported | Done |
| Visual contract and production specifications | Done |
| Original CEO vector idle front prototype | Done (prototype, not approved) |
| CEO character turnarounds ready for runtime | Pending |
| Rigged/sliced production-ready CEO sprite frames | Pending |
| Walk in four directions | Pending |
| Work / phone / talk / meeting clips | Pending |
| Canvas2D image loading and sprite fallback | Pending |
| Reuse approved rig for five remaining roles | Pending |
| Room furniture/props/effects asset pack | Pending |

The initial concept **reference sheet** generated during design review is distinct from the runtime vector placeholder. The concept image is not yet imported as a repository binary asset; do not link to it from production code or pretend its walk thumbnails are frames.

## Integration policy

1. Use the existing 24×16 rectangular Canvas2D office grid with 48px tiles.
2. Existing procedural renderer remains working throughout the migration.
3. Introduce new sprites via optional manifest-backed loading and graceful fallback.
4. Do not change model/tokens/state measurements when introducing visual assets.
5. Only merge this feature branch after in-app render, reduced-motion, camera rotation and typecheck tests pass.
