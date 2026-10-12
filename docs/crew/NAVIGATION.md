# Agent navigation and real local walking (#129)

A Crew marker reported as `isWalking` now moves across its room's real
walkable floor, around furniture, instead of snapping between two static
presence slots while playing a walk-cycle sprite in place. Resting markers
are unaffected; the domain's own `agent.x/y/targetX/targetY` are never read
or written by any of this: it is a presentation-only local animation on top
of the slot `projectCrewPresence` already assigns.

## What already existed, and what this issue closes

Earlier issues (#170 `crewRoutes.ts`, #128 `crewActorActions.ts`) had already
built the real data structures a navigation system needs: a per-room walkable
grid graph with BFS pathfinding (`buildCrewWalkGraph`/`findCrewWalkPath`), a
door graph with open/locked state (`buildCrewRoomGraph`/`findCrewRoomRoute`),
a multi-room transfer planner (`planCrewRoomTransfer`), and a pure, exclusive
workstation reservation map (`reserveCrewWorkstation`/`releaseCrewWorkstation`),
all in `crewRoutes.ts`/`crewAgentNavigation.ts`, all unit-tested, and all
**unused outside their own tests** until this change. Nothing in the live
render ever called them: a walking marker was drawn exactly where
`projectCrewPresence`'s hash/arrival-point logic placed it, for its entire
walk, with no interpolation across the floor.

This issue wires the existing walk-graph/pathfinding layer into the live
render via two new modules:

- `crewAgentWalk.ts`: pure segment math. `buildCrewWalkSegment` calls the
  existing `planCrewWalkWithinRoom` to get a real, furniture-avoiding path
  between two points; `crewWalkPosition`/`crewWalkFacing` interpolate a point
  and a facing along it at constant `CREW_WALK_SPEED` (local units/second);
  `nearestCrewWalkNode` finds the closest walk-graph node to an arbitrary
  point, used to replan from a genuine mid-flight position.
- `useCrewAgentWalk.ts`: the `CrewStage` hook. Tracks each visible agent's
  last known resting point; the moment a walking marker's assigned slot
  changes, it builds a new segment from that last point to the new one and
  renders the interpolated position/facing every animation frame until it
  arrives, at which point it reports exactly the slot `projectCrewPresence`
  assigned, never a different final position than before this change.

## Honest scope: what this does and does not claim

- **Within-room walking** avoids real furniture (desks, chairs, screens,
  plants), using the same collision rules every resting slot already
  respects (`crewPointIsFree`/`crewCollision.ts`). Verified for the CEO and
  Development rooms, and exercised across every room in the catalog.
- **An agent first seen walking never gets an invented starting point.** With
  no prior known position for that id, it renders at its assigned slot
  immediately; the next time its target changes while still walking, it
  animates from there. This matches the project's standing rule against
  inventing data the domain never reported.
- **Cancellation.** The moment the domain reports an agent as no longer
  walking, or it leaves the room, or the viewer switches rooms, any
  in-progress animation is discarded immediately: it never keeps walking in
  the background toward a destination the domain already abandoned.
- **Replanning** happens whenever a still-walking agent's target changes
  mid-flight: a new segment is computed from the agent's current interpolated
  point (snapped to the nearest real walk-graph node), never from its old
  destination. There is no dynamic obstacle to interrupt a walk around, since
  furniture is static; "replanning" here means "the destination changed",
  not "something blocked the path that wasn't there before".
- **Reduced motion** (the user preference, or the OS-level media query) skips
  all interpolation: a walking marker still ends up at its real target, it
  just never animates the trip.
- **Crowd handling is intentionally minimal.** Every simultaneously walking
  agent gets its own independent, furniture-avoiding path (verified with 50
  concurrent walkers across every room). Agents do not currently steer around
  each other mid-walk; `projectCrewPresence` already guarantees no two agents
  share the same resting or arrival slot, so paths converge on distinct
  endpoints, but two paths can still visually cross. A full steering/avoidance
  layer is out of scope here and would need its own ADR.
- **Door-based multi-room transfer** (`planCrewRoomTransfer`) and the general,
  non-boss-restricted workstation reservation (`reserveCrewWorkstation`) exist
  as tested, reusable data structures but are **not** wired into this change.
  Crew only ever renders one room at a time by design (#169), so there is no
  "walking out one door and into another room's view" to animate without
  showing two rooms at once; `crewActorActions.ts`'s existing boss-only seat
  dedupe is left as-is because only the CEO role has seated art today (#119-123
  remain the real gate on generalizing it).

## Verification and evidence

```sh
npm run lint
npm run test:unit
npx playwright test tests/e2e/crew-agent-navigation-129.spec.ts tests/e2e/crew-walk.spec.ts tests/e2e/crew-navigation.spec.ts tests/e2e/crew-camera.spec.ts
```

`tests/lib/crewAgentWalk.test.ts` covers segment construction, interpolation,
completion, facing derivation, the nearest-node replanning helper, and a
50-agent-per-room stress pass with no exceptions. `tests/lib/useCrewAgentWalk.test.ts`
covers the hook's state machine directly: no invented start, real animation
to a new target, reduced-motion snapping, cancellation, room-switch cleanup,
an agent leaving mid-walk, and a 50-agent crowd. The E2E spec drives the real
`CrewStage` canvas (via the existing `crew-walk` fixture, extended with an
opt-in `?workspace=` param that defaults to its original value so no existing
test changes behavior) and reads actual `drawImage` destination coordinates,
the same technique `crew-walk.spec.ts` already uses for frame counting,
applied here to position instead: a real walk from the resting slot to the
room's door, around a desk, with a cancellation case.

See [runtime evidence](evidence/navigation-129/README.md). This closes the
wiring gap for #129; it does not implement cross-room walk-through animation,
general crowd steering, or non-CEO seat reservations, each noted above as
explicitly out of scope.
