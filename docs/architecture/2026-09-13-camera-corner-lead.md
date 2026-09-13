# Camera corner lead

Date: 2026-09-13

Status: accepted

Implements the camera half of the P1 "make every vehicle input feel answered" slice in
`docs/plans/2026-09-06-game-feel-variation-roadmap.md`. Analysis that selected this slice:
`docs/plans/2026-09-13-analysis-and-improvements.md`.

## Context

`resolveCameraPlacement` in `cameraRig.ts` is a pure function of a body's position and its
*instantaneous* heading. That is what makes it testable without a WebGL context, and it is
worth keeping. It also means the shot points exactly where the car points, so the camera
arrives at a corner at the same moment the car does. A driver has looked into the bend well
before reaching it; a camera that only reports the present heading reads as following the
car rather than reading the road.

The roadmap asks for "a small configurable camera look-ahead into turns ... with
reduced-motion disabling both".

## Decision

A new pure module, `src/svartaksi/cameraLookAhead.ts`, holding three things:

1. `createHeadingRateTracker()` — carries a heading between frames and reports a smoothed
   yaw rate in rad/s.
2. `lookAheadLateralOffset(turnRate, speed, gain)` — how far to the left of the body the
   aim should sit, in metres.
3. `modeTakesLookAhead(mode)` — which camera modes want a lead at all.

plus `applyCameraLookAhead`, a transform over a finished `CameraPlacement`.

### Why a placement transform rather than a parameter to `resolveCameraPlacement`

`cameraRig.ts` already establishes this shape: `clampPlacementAboveGround` and
`pullPlacementClearOfObstruction` both take a resolved placement, bend it, and hand it
back. Following it means `resolveCameraPlacement`'s signature does not change, so all of
its existing tests keep testing exactly what they tested before and serve as a free
regression check that the other modes are untouched.

It also keeps a genuine separation. A rig is geometry — given a pose, where does the boom
sit. A lead is *motion*: it needs the derivative of the heading, which no rig has and which
has to be carried between frames. Putting state behind the rig's pure interface would have
cost the property that makes the rig worth having.

### Why the offset is a prediction rather than a tuned curve

A body turning at `w` rad/s while travelling at `v` m/s is under a lateral acceleration of
`v * w` — that is `v^2 / r` with `r = v / w`. Half that times `CAMERA.lookAheadTime`
squared is where it carries the body in that time, so the aim lands on the piece of road
the body is about to occupy.

Two properties the feature needs fall out of the formula instead of being special-cased:
the lead is zero in a straight line at any speed, and zero at a standstill however hard the
wheel is turned. Only `lookAheadTime` (0.6s, about a driver's own glance ahead) is a taste
value; `lookAheadMaxLateral` and `lookAheadMaxTurnRate` are guards, not tuning.

### Why only the aim moves

Moving the camera instead would change the framing distance mid-corner, which is what the
player's existing `distance` dial is for. Moving the aim's height would tilt the horizon on
every bend. Displacing the aim horizontally leaves exactly the intended read: the body
drifts toward the edge of frame as the corner opens up ahead of it.

### Why it is applied after the collision corrections

The ground clamp and the sightline pull both reason about the line between the camera and
the body it frames, and a led aim is no longer on that line. Correcting against the body's
true position and leading afterwards means the lead can never talk the camera into or out
of a wall.

### Why one dial and not a reduced-motion subsystem

`CameraSettings` already exists as the place a player's camera preferences live, validated
by `normalizeCameraSettings` and rendered by `App.tsx` off `CAMERA_SETTING_BOUNDS`. A
`lookAhead` dial with a minimum of exactly 0 is both the "configurable" and the
"reduced-motion disabling" the roadmap asks for: at 0 the aim points exactly where the body
points, which is the behaviour that shipped before this existed. Adding a separate
accessibility flag would have been a second control meaning the same thing.

Default is 1 — under a metre of lead through ordinary town cornering.

## Consequences

- `CameraSettings` gains a fifth field. `normalizeCameraSettings` supplies the default for
  any older saved settings that lack it, so stored preferences survive.
- Top-down and orbit deliberately do not lead: top-down already shows the corner and a
  lateral aim would tip it off vertical, and orbit is a sweep with a motion of its own.
- The tracker sees no frames while the player is in freecam or the bus passenger seat,
  both of which return before the placement branch. It resumes holding a stale heading;
  its rate clamp and smoothing absorb that over a frame or two. Accepted rather than reset,
  because the visible consequence is bounded and small.

## Verification

`tests/svartaksi/cameraLookAhead.test.ts` — 22 tests covering the tracker (first frame,
steady turn in both directions, the +/-pi seam, a teleport-scale discontinuity, a zero-length
frame), the offset formula (zero straight, zero parked, zero at gain 0, the exact
prediction, the cap, and that ordinary town cornering stays under a metre and a half), the
transform (aim moves, camera does not, height does not, swings with heading, exact no-op at
gain 0), and the mode predicate.

Camera *feel* is not verified here. This project has no browser-automation layer by design,
so the geometry is unit-tested and how the lead reads in motion is unplaytested.
