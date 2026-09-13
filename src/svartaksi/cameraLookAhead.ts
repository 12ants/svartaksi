/**
 * Leading the shot into a corner: how far ahead of itself the follow camera should aim
 * when the body it is following is turning, and how to measure that turn in the first
 * place.
 *
 * `cameraRig.ts` answers where the camera goes as a pure function of position and
 * *instantaneous* heading, which means the shot points exactly where the car points and
 * arrives at a corner at the same moment the car does. A real driver has looked into the
 * bend well before reaching it, and a camera that does the same reads as anticipating the
 * road rather than reporting it. This module is that anticipation, and nothing else: it
 * moves the aim, never the camera.
 *
 * Kept out of `cameraRig.ts` because it is a different kind of thing. A rig is geometry —
 * given a pose, where does the boom sit. A lead is *motion* — it needs the derivative of
 * the heading, which no rig has and which has to be carried between frames. Expressed as
 * a transform applied to a finished placement, it composes with the ground clamp and the
 * sightline pull already in `cameraRig.ts` and leaves `resolveCameraPlacement`'s signature
 * and every one of its existing tests untouched.
 *
 * Convention throughout, inherited from `cameraRig.ts`: forward is `(sin h, 0, cos h)`,
 * and `+x` is left of forward. Heading increases counterclockwise, so a positive yaw rate
 * is a left turn and a positive lateral offset is to the left.
 */
import type * as THREE from 'three';

import type { CameraMode } from './cameraModes';
import { CAMERA } from './gameplayConfig';

/** The shape this transform works on — `cameraRig.ts`'s `CameraPlacement`, restated
 * structurally so this module does not have to import a rig to bend one. */
export interface AimablePlacement {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/**
 * Carries a heading between frames and reports how fast it is turning, in rad/s.
 *
 * Stateful by necessity — a rate is a difference, and there is nowhere else for the
 * previous sample to live — but state is all it is: one instance per mounted runtime, no
 * scene, no clock of its own, and a caller who supplies the time step.
 *
 * Three things it has to survive, none of which are turns:
 *
 * - the first frame, where there is no previous heading to difference against and the
 *   honest answer is that nothing is known to be turning;
 * - the `+/-pi` seam, where a heading that has moved a hundredth of a radian reads as
 *   having moved nearly a full revolution unless the difference is wrapped;
 * - a genuine discontinuity — a teleport, or the player leaving the car for the pill,
 *   whose headings have nothing to do with one another. That is not a wrap and cannot be
 *   wrapped away, so it is clamped instead: one implausible frame becomes one frame at a
 *   plausible maximum, which the smoothing below then largely swallows.
 */
export interface HeadingRateTracker {
  /** Feeds in this frame's heading and returns the smoothed yaw rate, rad/s. */
  update(heading: number, dt: number): number;
}

/** Shortest signed angle for a raw heading difference, in (-pi, pi]. */
function wrapAngle(delta: number): number {
  const wrapped = (delta + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export function createHeadingRateTracker(): HeadingRateTracker {
  let previous: number | null = null;
  let smoothed = 0;

  return {
    update(heading, dt) {
      if (!Number.isFinite(heading) || !Number.isFinite(dt) || dt <= 0) return smoothed;
      if (previous === null) {
        previous = heading;
        return 0;
      }
      const raw = clamp(wrapAngle(heading - previous) / dt, CAMERA.lookAheadMaxTurnRate);
      previous = heading;
      // Exponential smoothing against the real time step, so the filter behaves the same
      // at 30fps as at 144 — the same form the camera's own easing uses.
      smoothed += (raw - smoothed) * (1 - Math.exp(-dt / CAMERA.lookAheadSmoothingTau));
      return smoothed;
    },
  };
}

/**
 * How far to the left of the body the aim should sit, in metres, for a body travelling at
 * `speed` m/s and yawing at `turnRate` rad/s. Negative is to the right.
 *
 * The number is a prediction, not a taste: a body turning at `w` while travelling at `v`
 * is under a lateral acceleration of `v * w` — that is what centripetal acceleration is,
 * `v^2 / r` with `r = v / w` — and half of that times the square of `CAMERA.lookAheadTime`
 * is where it carries the body in that time. So the aim lands, as nearly as a constant-rate
 * assumption allows, on the piece of road the body is about to occupy.
 *
 * Two properties fall out of the formula rather than being bolted on, and both matter:
 * it is zero in a straight line at any speed, and zero at a standstill however hard the
 * wheel is turned. The lead can only appear when the body is actually going somewhere and
 * actually turning, which is the whole of when it is wanted.
 *
 * `gain` is the player's dial. Zero is off — exactly off, not nearly — which is what
 * makes this one control and not a separate reduced-motion switch.
 */
export function lookAheadLateralOffset(turnRate: number, speed: number, gain: number): number {
  if (gain <= 0) return 0;
  const lateralAcceleration = speed * turnRate;
  const offset = 0.5 * lateralAcceleration * CAMERA.lookAheadTime ** 2 * gain;
  return clamp(offset, CAMERA.lookAheadMaxLateral);
}

/**
 * Displaces a finished shot's aim into the turn, in place, and hands the same object back
 * so this chains with the corrections in `cameraRig.ts`.
 *
 * Only `lookAt` moves, and only horizontally. Moving the camera instead would change the
 * framing distance mid-corner, which is what the player's `distance` dial is for; moving
 * the aim's height would tilt the horizon on every bend. What is left is the one thing
 * asked for — the body drifts toward the edge of frame as the corner opens up ahead of it.
 */
export function applyCameraLookAhead(
  placement: AimablePlacement,
  heading: number,
  turnRate: number,
  speed: number,
  gain: number,
): AimablePlacement {
  const offset = lookAheadLateralOffset(turnRate, speed, gain);
  if (offset === 0) return placement;
  // Forward rotated a quarter turn counterclockwise about +y: left, by this world's
  // convention. At heading 0 it is +x, which is what `cameraRig.ts` says left is.
  placement.lookAt.x += Math.cos(heading) * offset;
  placement.lookAt.z += -Math.sin(heading) * offset;
  return placement;
}

/**
 * Whether a camera mode wants a lead at all.
 *
 * The four that do are the ones framing the road in front of the body: the chase boom,
 * both first-person seats, and the cinematic flank. Top-down is excluded because it is
 * already looking at the corner from above and a lateral aim would only tip the shot off
 * vertical; orbit because it is a sweep with a motion of its own that a second moving aim
 * would fight; freecam because it follows no body and never reaches this code.
 *
 * A predicate rather than a check buried in the transform, so the decision is as testable
 * as the arithmetic it guards.
 */
export function modeTakesLookAhead(mode: CameraMode): boolean {
  return mode === 'chase' || mode === 'hood' || mode === 'cockpit' || mode === 'cinematic';
}
