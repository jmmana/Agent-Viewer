# PR #43 recovery audit and Crew migration acceptance (#115)

Audit date: 2026-10-12. Scope: reconcile the published resource bank, its source
history and the evidence of use in independent Crew. This closes the recovery
inventory, not production art acceptance or the whole [Crew epic #114](https://github.com/jmmana/Agent-Viewer/issues/114).
The dependencies #166, #167 and #172 are closed. No runtime or original artwork
changes are needed for this audit.

## Source revisions and preservation

| Source | Exact revision | Disposition |
| --- | --- | --- |
| [PR #43](https://github.com/jmmana/Agent-Viewer/pull/43) | `355e9194bd83d8b741bc65d5b58a897d320ee584` (head) | OPEN, DRAFT, base `main`, no merge commit as checked on the audit date. Keep in draft pending architecture and dual-mode review. |
| [PR #162](https://github.com/jmmana/Agent-Viewer/pull/162) | `5e2e586347ecec2b73480f266fb41ad9d1a63fdd` (merge) | Merged into `feat/visual-assets-v1`; recovery audit, validators and clip registration. Portable principles, not a Crew renderer. |
| [PR #163](https://github.com/jmmana/Agent-Viewer/pull/163) | `71c189b5e225c08c7c7cfc0ce8eac9e74bf952c2` (merge) | Merged into the same visual branch; showroom frame preview, not final runtime acceptance. |
| [PR #164](https://github.com/jmmana/Agent-Viewer/pull/164) | `355e9194bd83d8b741bc65d5b58a897d320ee584` (merge) | Merged into the visual branch; four illustrated furniture pieces injected into the legacy Canvas. Exclude its rendering dependency from Crew. |
| [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194) | `a867cd2260ea7330a29a01bb380d7d41d467e8f7` (merge) | Independent Crew and non-destructive source bank integrated into `main`. |
| [PR #218](https://github.com/jmmana/Agent-Viewer/pull/218) | `920dce7a3ea41468979125d82408c2a3f2fa7291` (merge) | Accepted migration audit for #172. |
| [PR #252](https://github.com/jmmana/Agent-Viewer/pull/252) | `08b90fff88f205d5e552210751027e29c2910919` (merge) | Executive desk and floor plant pilot in independent Crew. Same source SVG billboard in four camera views, not four approved perspectives. |

The [original recovery audit](https://github.com/jmmana/Agent-Viewer/blob/355e9194bd83d8b741bc65d5b58a897d320ee584/docs/visual-system/AUDIT-2026-10-08.md)
inspected the earlier head `b64440406020a9302d218a0da3ec3a31ec58ffc6`.
Its feature-branch-only statements describe that date. They do not supersede the
later bank import or imply that #43 itself was merged into `main`.

Rechecking the 54 bank files directly against `git show <sourceCommit>:<sourceFile>`
on 2026-10-12 found **54/54 byte-identical** originals. Nothing was regenerated.
The branch retains the showroom layouts and vector studies in their original paths.

## Inventory and classification

The [53-row migration matrix](ASSET-MIGRATION-PR43.md) supplies each ID, original
path, classification and Crew destination. The authoritative
[asset manifest](../../assets/crew/asset-manifest.json) adds each destination file,
source commit, SHA-256, MIME type, dimensions, license, provenance and available
views. Together these cover every asset without maintaining a second divergent
list of hashes.

| Material at the source revision | Count | Classification and destination |
| --- | ---: | --- |
| Character PNG poses | 11 | Runtime **prototype**: six CEO static poses and one front pose for each other role. Import originals to `assets/crew/bank/characters/`; use Crew adapters. Missing views and genuine clips remain separate art work. |
| Furniture SVG | 20 | Runtime **prototype** in `assets/crew/bank/furniture/`; import original art, adapt local anchors and perspective. Desk/plant pilot does not approve all furniture. |
| Electronics SVG | 13 | Runtime **prototype** in `assets/crew/bank/electronics/`; adapt surfaces and real-event semantics in Crew. |
| Effects SVG | 9 | Runtime **prototype** in `assets/crew/bank/effects/`; event-driven Crew layers or explicitly labeled DEMO. |
| `assets/references/ceo-approved-concept.png` | 1 | Approved **style reference**, copied as `reference.ceo`; its reference approval does not promote any runtime asset to `approved`. |
| `assets/rooms/*/layout.json` | 3 | Showroom **reference/prototype** layouts, listed below. Retain source; port concepts to local `CrewRoomDefinition`, not the legacy grid. |
| `assets/characters/*/vector-study/**/*.svg` | 1,584 | **Vector studies**, excluded from final animation/runtime claims. Count rechecked from the source tree. |
| `src/visual-studio/**` | Source tree | **Showroom reference**; previewing frames is not proof of integration in Crew. |
| `scripts/register-office-clip.mjs`, `scripts/validate-visual-assets.mjs` | Source tools | **Portable pipeline principles**: frame distinctness, dimensions, alpha and layout validation. Refactor against the [Crew frame contract](FRAME-PIPELINE.md), do not import legacy loaders. |
| `src/engine/officeCrewAssets.ts`, `officeFurnitureAssets.ts`, `canvasRenderer.ts`, `visualMotion.ts` | Source code | **Legacy code**: retain as historical reference, exclude legacy drawing and furniture injection dependencies from Crew. Translating or bobbing a static pose is not an animated walk cycle. |

All 53 manifest assets remain `prototype`; zero are `approved`. Runtime use,
reference approval and production-art approval are separate facts. MIT is the
recorded license for the bank and the three layouts, with original project
provenance; these metadata are traceability evidence, not a new external license
or authorship certification. Any recovered asset without provenance remains
unverified until inspected.

### Three showroom layouts

All paths below are relative to `assets/rooms/` at the pinned PR #43 revision.
Each JSON declares `schemaVersion: "1.0.0"`, `status: "prototype"`, MIT license,
`rectangular-ground-pixels`, asset anchors, placements, doorways and spawn points.
None is an independently mounted Crew scene merely because its JSON exists.

| Path | Placements | SHA-256 of original JSON | Crew destination |
| --- | ---: | --- | --- |
| `director-suite/layout.json` | 8 | `919cdd037978c090bd9460d33df3948fc776052b6bf381f4d8345c7df251ba6e` | Direction composition reference (#131); adapt to local scene and camera. |
| `meeting-room/layout.json` | 12 | `9331e053bf1a32468765ea2780f6bbb2487a80d51054fb2b364969c03e3327f0` | Meeting composition reference (#138); use Crew actor/seat contracts. |
| `coffee-area/layout.json` | 9 | `8600e86d1cd569c58a364ecf20b223b312e00a2110f0b0236096ccf3b8af2058` | Lounge composition reference (#139); event and animation work separate. |

The migrated asset JSON has `schemaVersion: 1`, `usage: "source-bank"` and
per-asset `id`, `file`, `sourceFile`, `sourceCommit`, `sha256`, `license`,
`status` and `viewAvailability`. Static character entries use `frames: 1`,
`fps: 0`, `loop: false`. No loader should infer animation from a filename or
from movement through the scene. Scene and lifecycle contracts are documented
in [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md), separate from this
source-bank schema.

## Local changes: INDETERMINADOS

Earlier claims about unpublished day/night, music, CEO/Developer dancing,
walking/typing frames or work from a disconnected session remain
**INDETERMINADOS (unverified)** without that session's commit, patch or original
workspace. Later implementations do not retrospectively prove those claims.
The current registered worktrees were inspected; no unfinished issue #115
worktree or `.claude/worktrees/agent-*/` recovery was found. Existing unrelated
local edits and worktrees are preserved and are not credited as #115 delivery.

Recovery rule: inspect a supplied SHA/patch, record provenance and compare
bytes before importing anything. Do not overwrite originals or regenerate
missing material just to make an inventory appear complete.

## Acceptance evidence and limits

| Required evidence | Published evidence and scope |
| --- | --- |
| Technical specification and relevant JSON | Per-ID matrix and source-bank JSON above; ADR-002 and Crew frame contract separate art, runtime and domain state. |
| Integration in independent Crew | PR #194 and [PR #252](https://github.com/jmmana/Agent-Viewer/pull/252); `src/crew/crewSprites.ts` and `crewPropImages.ts`, not the showroom or legacy furniture renderer. |
| Unit/E2E and room-only desktop/mobile views | `tests/crew-assets.test.mjs`, `tests/lib/crewPropImages.test.ts`, `tests/e2e/crew-prop-images.spec.ts` (four camera presets, 390x844 screenshot, room switch and load failure). [CEO four-view/mobile captures](evidence/ceo-118/) and [camera evidence](evidence/camera-156/) document the earlier independent runtime. These captures do not certify all 53 resources. |
| DEMO, LIVE/REPLAY integrity and privacy | `tests/e2e/crew-domain.spec.ts`, `tests/lib/crewEventBridge.test.ts`: shared observable state, explicit source mode and no synthetic LIVE activity. No private model reasoning is an asset input. |
| Caricatura regression and cleanup | `tests/crew-mode-boundary-166.test.mjs`, `tests/lib/crewMountLeak.test.tsx`, `tests/e2e/crew-domain.spec.ts`; mode return preserves data and the legacy canvas, with listeners/RAF disposed. |
| PR, SHA, CI and motion evidence | Source table above; [PR #194 CI](https://github.com/jmmana/Agent-Viewer/actions/runs/37923058757), [PR #252 CI](https://github.com/jmmana/Agent-Viewer/actions/runs/38065878729), [runtime navigation MP4](evidence/camera-156/runtime-navigation.mp4), [four-view CEO MP4](evidence/ceo-118/four-views.mp4). Videos demonstrate runtime/camera behavior, not final walk cycles. |

The [#172 acceptance record](ISSUE-172-ACCEPTANCE.md) documents the prior evidence
review. This documentary reconciliation does not claim a new manual visual
acceptance or a fresh E2E execution; its PR records the checks actually rerun.
Neither screenshots nor green CI alone establish completed production art.

The recovery/audit deliverable of #115 is complete. Production artwork, missing
perspectives, per-role clips and broader room integration remain with #118-154;
they are not silently accepted by this closure. [PR43-CONSOLIDATION.md](PR43-CONSOLIDATION.md)
continues to govern any future retirement proposal. Caricatura remains available,
and PR #43 remains draft and unmerged.
