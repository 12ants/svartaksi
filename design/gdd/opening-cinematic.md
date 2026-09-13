# Opening Cinematic

## Overview

A ~32-second authored sequence that plays once, on load, before the player has control. A
bus crosses a forest road at late evening under strong headlights; the camera follows it
through a snaking country road; then the camera bolts to the bus itself, framing a spinning
front wheel, and — without a cut the player can see — the forest becomes the city, the
cinematic ends, and the player is aboard a real bus a short ride from their parked taxi.

## Player Fantasy

Arrival. The game does not begin with the player somewhere; it begins with them *getting*
somewhere, at the end of a long ride through the dark, on the last bus into town. The three
shots move steadily inward — a road the bus is a stranger on, then alongside it, then
finally *on* it — so that by the time control arrives the player is already inside the
vehicle they have been watching. The taxi they will drive is waiting when they step off.

The tone is quiet and late: headlights on empty tarmac, trees crowding a verge, nobody
about. Nothing is explained.

## Detailed Rules

1. The cinematic plays on load unless `?intro=0` is in the URL.
2. The loading curtain stays up until the intro stage has finished building. The player's
   first frame is scene 1, complete, never a clearing filling in with trees.
3. Player input is suspended for the whole cinematic (`inputPaused`).
4. The bus drives an authored road under the ordinary bus motion model, starting already at
   road speed rather than from rest.
5. Time of day is forced to 21.5 for the duration, and restored to the session's own clock
   at the handoff.
6. World streaming is suspended for the duration. The real world load runs underneath and
   its result is held, not applied.
7. Shots play in order, each for its authored duration:

   | # | Shot | Kind | Duration | FOV |
   |---|------|------|----------|-----|
   | 1 | Tripod beside the road; bus enters right, exits left | `locked-off` | 8s | 32° |
   | 2 | Follow through the weave, drifting left to right and rising | `follow` | 16s | 38° |
   | 3 | Bolted to the bus, aimed forward, front wheel lower right | `bolted` | 8s | 52° |

8. The gameplay HUD is masked for the duration. The player's own HUD preferences are not
   changed, only hidden.
9. Scene 3 **holds past its duration** until the real world has both arrived *and* finished
   building. It never cuts to an unloaded or half-assembled world.
10. The handoff is two steps:
    - **Swap** (data has arrived): adopt the real world, restore the clock, re-ground the
      parked car, start a short arrival ride toward it. Streaming resumes.
    - **Release** (the rebuild has drained): return the camera to cockpit, restore input
      and the HUD.
11. If no drivable road is loaded near the car, the player is set down beside it on foot
    instead of being left aboard a bus with nowhere to go.
12. If the real world load fails outright, the cinematic ends immediately so the error
    curtain can be seen.
13. Any keypress or pointer press skips. A skip before scene 3 winds forward to scene 3
    rather than cutting out, so the hidden handoff still happens.

## Formulas

**Corner speed** — the road's geometry sets the bus's pace, via the existing profile:

```
v_corner = clamp(sqrt(BUS_LATERAL_ACCEL * r), BUS_MIN_CORNER_SPEED, BUS_SPEED)
         = sqrt(1.3 * 65) = 9.19 m/s   for the weave radius of 65 m
```

**Scene 1 framing** — how long the bus is in shot, and therefore the padding at each end:

```
frame_half_width = d * tan(fov_v / 2) * aspect        = 46 * tan(16°) * 16/9 = 23.4 m
visible_seconds  = (2 * frame_half_width + bus_length) / v
                 = (46.8 + 11) / 12.5                 = 4.6 s
pad_each_end     = (shot_seconds - visible_seconds)/2 = (8 - 4.6)/2 = 1.7 s
```

**Projection to frame position** (used to verify framing, not at runtime):

```
z_axis = normalize(eye - target);  x_axis = normalize(up × z_axis);  y_axis = z_axis × x_axis
depth  = -(p - eye) · z_axis
ndc.x  = ((p - eye) · x_axis) / (depth * tan(fov_v/2) * aspect)
ndc.y  = ((p - eye) · y_axis) / (depth * tan(fov_v/2))
```

**Road tracing** — constant-curvature segments integrated at a fixed step, midpoint heading:

```
h_mid = h + (κ * step)/2;   x += sin(h_mid)*step;   z += cos(h_mid)*step;   h += κ*step
```

## Edge Cases

| Situation | Behaviour |
|---|---|
| Real world arrives before scene 3 | Held in `introPendingWorldRef`; adopted at the handoff, never mid-shot. |
| Real world still loading when scene 3's 8s expire | Scene 3 holds on the wheel. The road has ~170m of run-out past the cinematic's end so the bus is not braking while it waits. |
| Real world arrived but still assembling | The camera stays bolted until `world.pump` drains, so the city is never seen building. The build runs at the curtain's budget meanwhile. |
| Bus model still loading on the first frame | Scene 1 plays anyway — it is locked off and never frames the bus. The camera is not handed to the player's rig in the meantime. |
| Player's HUD regions were turned off already | Unchanged: the mask only hides, and restores whatever was set. |
| Real world load fails | Intro ends at once; the normal retryable error curtain is shown. |
| No bus-drivable road near the parked car | Arrival ride skipped; player set down on foot beside the taxi. |
| Player skips during scene 1 or 2 | Clock winds to scene 3's start; handoff proceeds as normal. |
| Player skips before the world has loaded | Scene 3 holds as usual. A skip cannot outrun the network. |
| Ultrawide (21:9) display | Scene 1's padding narrows to ~1.1s per end but never closes. Asserted in test. |
| Runtime unmounted mid-cinematic | Skip listeners removed in the effect teardown. |
| `?intro=0` | Nothing above runs; the game opens exactly as it does today. |

## Dependencies

- `busRouting.ts` — profile, speed integration and path sampling (unchanged)
- `busLifecycle.ts` — the arrival, doors and alight at the end of the handoff ride
- `world/threeWorld.ts` — `world.replace`, and tree scattering from park polygons
- `world/vegetation.ts` — the forest, from the authored polygons alone
- `world/timeOfDay.ts` — `sceneLighting`, for the dusk and the night factor
- `busModel.ts` — `setBusNightFactor`, which gates the headlights
- `svartaksiRuntime.tsx` — `adoptWorldData`, `applyStartBusRide`, the camera branch
- `config.ts` — `isIntroRequested`

## Tuning Knobs

| Knob | Where | Current | Effect |
|---|---|---|---|
| `WEAVE_RADIUS` | `introStage.ts` | 65 m | Sets scene 2's speed *and* how hard the road bends. Lower is slower and twistier; must stay well above `minTurnRadius` (9.5 m). |
| `WEAVE_SWEEP` | `introStage.ts` | 0.5 rad | How far off axis each bend swings. Raising it lengthens the weave, so scene 2's duration must follow. |
| `VERGE` / `FOREST_DEPTH` | `introStage.ts` | 11 m / 150 m | How close the trees crowd, and how far the wood runs back. |
| Run-out length | `introStage.ts` | 260 m | Headroom for scene 3 to hold on a slow load. |
| `INTRO_HOUR` | `introSequence.ts` | 21.5 | Dusk. Must keep `nightFactor > 0.35` or the headlights go out. |
| `INTRO_START_SPEED` | `introSequence.ts` | 12.5 m/s | Whether the bus is already at speed when scene 1 opens. |
| `TRIPOD_DISTANCE` / scene 1 `fov` | `introSequence.ts` | 46 m / 32° | Together set scene 1's padding. Widening either shortens it. |
| Shot `seconds` | `introSequence.ts` | 8 / 16 / 8 | Pacing. Must stay cut against the measured ride profile. |
| Scene 2 `back` / `sideFrom`→`sideTo` / `upFrom`→`upTo` | `introSequence.ts` | 15 / 7.5→−7.5 / 3.2→4.6 | The follow's framing and its drift across the shot. |
| Scene 3 `offset` / `aim` | `introSequence.ts` | (2.2, 1.15, 2.2) / (0.4, 0.15, 18) | Where the wheel sits in frame. |
| `ARRIVAL_RIDE_METERS` | `introArrival.ts` | 250 m | How long the handoff ride runs before pulling in. |

## Acceptance Criteria

Automated (`tests/svartaksi/intro{Stage,Sequence,Arrival}.test.ts`, 35 tests):

- [x] The authored road reports **no infeasible corners**.
- [x] The bus holds road speed through scene 1 and is still at road speed, with >100 m of
      road left, when scene 3 ends.
- [x] Scene 1's tripod does not move as the bus moves.
- [x] The bus's frame position decreases monotonically through scene 1, starting positive
      and ending negative — it enters from the right and exits to the left.
- [x] The bus is fully off camera at t=0, t=1, t=7 and t=8 of scene 1, at both 16:9 and
      21:9, and fully in frame at t=4.
- [x] `sceneLighting(INTRO_HOUR).nightFactor > 0.35`, so the headlights are lit.
- [x] Scene 2 keeps the bus within the middle half of the frame across the whole weave.
- [x] Scene 3 frames the front wheel right of centre and inside the frame, aims within 18°
      of the bus's forward axis, and frames it *identically* at two unrelated bus poses.
- [x] Scattering the authored forest polygons yields >500 trees, none on the carriageway.
- [x] The arrival ride ends at the drivable vertex nearest the car, runs ~250 m, approaches
      rather than departs, ignores footways, and returns null rather than a two-point lurch.

Manual (`production/qa/evidence/`, advisory):

- [ ] No black frame and no camera pop at either cut.
- [ ] The world swap inside scene 3 is not visible.
- [ ] Control returns in the cockpit aboard a moving bus; the player alights beside the car,
      which is sitting *on* the road rather than buried in or floating above it.
- [ ] The HUD is absent for the whole cinematic and back afterwards, in whatever
      configuration it was in before.
- [ ] `?intro=0` opens the game exactly as before.
