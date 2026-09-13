# Opening cinematic

Date: 2026-09-13

Status: accepted

## Context

The game has no opening. `App.tsx` lifts the loading curtain and the player is parked in
the car at Gärdet, with no establishing shot and nothing said about where they are.

A scripted opening did exist once and was removed. The removal is recorded in
`config.ts`'s `START_LOCATION` comment: the old `OPENING_RIDE` ran a bus from
Hammarbyhöjden to Ryssbergen, a cross-town journey that needed a network round trip and a
long-distance A* search over a streamed road graph *before the player saw anything*. Both
could fail, and when they did they failed in front of a player who had not yet played.
`applyStartBusRide`, the general boarding mechanic, survived; the scripted journey did not.

The brief for this work is three authored scenes: a locked-off camera on a forest road at
late evening with a bus crossing frame under strong headlights; a follow through a snaking
country road; and a close-up on a spinning wheel with the camera bolted to the bus.

Nothing in `src/` could express any of that. There is no cutscene, timeline or sequence
system; `'cinematic'` is only the name of a player-selectable camera mode.

## Decision

Four pieces: three pure modules and a set of narrow bindings in `svartaksiRuntime.tsx`.

### The stage is synthesized `WorldData`, not streamed and not bespoke geometry

`src/svartaksi/introStage.ts` builds a `WorldData` in code — one road polyline, two forest
polygons — and hands it to the same pipeline every streamed tile goes through.

This is the decision the rest follows from. `WorldData` (`world/types.ts`) is plain data,
so an authored road is the same kind of thing as an OSM road: `threeWorld.ts` draws the
ribbon, `terrain.ts` lifts the landuse, `vegetation.ts` scatters the trees from any polygon
whose kind has a density in its `SPECIES` table, and `buildingLayer`/`physics` derive
colliders. **No renderer, physics or vegetation code changed.** Authoring two polygons is
what produces the forest; a test asserts that scattering them yields more than 500 trees.

It also answers the failure the previous opening died of. The stage needs no network at
all, so the player's first frame never waits on a fetch — and the real world streams in
*behind* the cinematic instead of in front of it.

The alternative — streaming a real wooded road somewhere near Stockholm — was rejected for
that reason, and because the shot framing would then depend on live OSM data that can
change under us.

### The bus is driven by the real motion model, on an authored path

`busRouting.ts` needs only a `LocalPoint[]`, so the authored spline goes through
`buildRideProfile` / `profileSpeedLimit` / `advanceRideSpeed` / `sampleRide` unchanged. The
bus in the cinematic is the bus, with its real acceleration, its real cornering limit and
its real suspension.

The consequence is that **the road's geometry sets the shot's pace, not the shot table**.
`buildRideProfile` turns a corner into a speed with `v = sqrt(BUS_LATERAL_ACCEL * r)`, so
the 65m weave radius *is* the 9.2 m/s the bus takes scene 2 at. Scene durations were cut
against the measured profile rather than assumed, and a test re-derives those marks and
fails if road and table drift apart.

This is also why "snaking" is a weave of 65m bends and not hairpins: at `BUS_CORNER_CUT`
and `BUS_MIN_CORNER_SPEED` a tight spline does not error, it silently degrades into a
crawl. 65m is well clear of `BUS_DIMENSIONS.minTurnRadius` (9.5m), so the route reports no
infeasible corners — asserted, not hoped for.

### The shots are their own vocabulary, not camera modes

`src/svartaksi/introSequence.ts` holds a data-driven shot table of three kinds —
`locked-off`, `follow`, `bolted` — and `resolveIntroShot`, a pure function from
(shot, time, bus pose) to a camera pose.

`'intro'` is deliberately **not** added to `CAMERA_MODES`. That array is the C-cycle
vocabulary and is persisted to user settings; a cinematic shot is not a mode the player is
in, it is the absence of player control. For the same reason the intro does not go through
`cameraRig.ts`: every rig there is something the player can select and adjust with their
own distance/pitch/FOV dials, and an authored shot must not move when they do.

The intro camera branch writes `state.camera` **directly**, following the freecam
precedent, rather than going through `createCameraTransformApplier`. That applier eases
position and slerps rotation toward their targets, which is right for a rig following a
body and wrong here twice over: a tripod would drift into place over the first second of
the shot, and a bolted mount would lag the bus through exactly the bends it is supposed to
be rigid through. Scene 2 is the only shot that moves, and it carries its own easing.

### The handoff hides inside scene 3

Scene 3 frames almost nothing but bodywork, so the world can be replaced underneath it
without the player seeing the change. `finishIntro` adopts the real world *while the bolted
camera is still holding*, and only then returns the camera.

Two things make this safe:

- **`adoptWorldData` was extracted** from `loadWorld`'s `.then()`. That block does far more
  than `world.replace` — `groundProfile` → `buildTerrainIndex` → `buildWaterIndex` →
  `buildingLayer.setWorld` → `placeCamp` → `placeDog` — and skipping any of it leaves the
  bus with no ground to sample. Both the real load and the intro share the one function.
- **The adopt is gated.** While `introHoldsWorldRef` is set, a real-world snapshot that
  arrives waits in `introPendingWorldRef` instead of being adopted; `world.replace` on
  arrival would otherwise dissolve the forest mid-shot. World streaming is suspended for
  the same window, because every restream trigger would read the bus's position on the
  authored stage as a huge journey — and each fetch bumps the load generation the pending
  ready status is keyed to.

Scene 3 **holds** until the real world has arrived. The bolted shot is the same frame
whether it runs for eight seconds or twenty, which is precisely why the handoff was put
inside it; `introStage`'s road carries a long run-out so the bus is not braking to a stop
while it waits.

The handoff does **not** use `applyTeleport`. That is guarded by `canRelocateWorld`, true
only while the bus phase is `'hidden'` — mid-ride it silently does nothing, and the handoff
would appear to work while leaving the bus in the woods.

### The ride it hands to is planned locally, not routed

`src/svartaksi/introArrival.ts`'s `planArrivalRide` picks the nearest bus-drivable vertex
to the parked car out of the world data that is *already loaded and drawn*, and walks
backwards along that one road for ~250m. No graph, no A*, no corridor fetch — which is the
whole point, given what the previous opening died of. Staying on a single carriageway also
means it cannot emit a path with a discontinuity in it. It returns null rather than a lurch
when there is nothing usable, and the caller sets the player down beside the taxi instead.

The existing bus lifecycle then does the rest: the ride's end is detected, the bus pulls in,
the doors open and the player alights next to their car — where ordinary play begins today.

## Consequences

- The player's first frame arrives sooner than it does now, not later: the intro stage is
  three polygons and builds behind the curtain in a fraction of the time a city does, while
  the real Gärdet load runs underneath the cinematic instead of ahead of it.
- The cinematic is ~32s and is skippable with any key or click. A skip mid-weave winds
  forward to the wheel shot rather than cutting out, so the same hidden cut still does the
  work. `?intro=0` bypasses it entirely, for anyone reloading the dev server all afternoon.
- Time of day is forced to 21.5 for the duration and restored afterwards. That hour is not
  cosmetic: `setBusNightFactor` lights the headlights only above a nightFactor of 0.35, so
  "strong headlights" is a property of the chosen hour and is asserted as one.
- Three new pure modules with 35 tests, and the framing claims in the brief — "enters from
  the right and exits to the left", "the wheel to the right in the frame", the head and
  tail padding — are checked by projecting to NDC rather than eyeballed.
- The intro branch is the camera's first branch and bypasses the rig path, look-ahead and
  FOV slider. Every existing camera test is untouched and still covers the player's modes.

## Alternatives rejected

- **Stream a real forest road.** Authentic, but reintroduces exactly the network dependency
  that killed the last opening, and pins shot framing to live OSM data.
- **Fade to black between scene 3 and gameplay.** Robust and simple, but a fade is what you
  use when you cannot hide a cut. Here the cut can be hidden, so it is.
- **Add `'intro'` to `CAMERA_MODES`.** Would have let the intro reuse the rig path, at the
  cost of leaking a non-selectable state into the player's C-cycle and their saved settings.
- **A general timeline/cutscene engine.** Nothing else in the game currently needs one. The
  shot table is data-driven, so the third scene of the second cutscene is the moment to
  build one — not the first scene of the first.
