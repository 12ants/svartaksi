/**
 * Where the camera goes, for each camera mode and each thing it can be following.
 *
 * Pulled out of svartaksiRuntime's frame loop because it is pure: given what the camera is
 * following and which mode it is in, the answer is a position and a look target, with no
 * reference to the scene, the clock, or React. That makes every rig testable without a
 * WebGL context, and leaves the frame loop with only the part that genuinely belongs to
 * it — easing the camera toward the answer.
 *
 * Convention throughout: forward is `(sin h, 0, cos h)`, so `+x` is left of forward.
 */
import * as THREE from 'three';

import type { CameraMode } from './cameraModes';
import type { CameraSettings } from './cameraSettings';
import { PERSON_EYE_Y } from './personModel';

/**
 * Framing distances for one kind of body. Every mode's numbers were tuned around a
 * 4.25m car; reused unchanged for a 1.7m pill they frame mostly empty street, so on foot
 * the whole rig pulls in and drops. Only the distances differ — resolveCameraPlacement
 * below is one implementation reading whichever rig the current mode selects.
 */
export interface CameraRig {
  targetUp: number;
  chaseBack: number;
  chaseUp: number;
  hoodForward: number;
  hoodUp: number;
  cockpitForward: number;
  cockpitUp: number;
  topDownUp: number;
  orbitRadius: number;
  orbitUp: number;
  cinematicBack: number;
  cinematicSide: number;
  cinematicUp: number;
  /**
   * Degrees the first-person modes tilt their aim by — the player's pitch dial (see
   * cameraSettings.ts), which has nowhere else to go in hood/cockpit because the camera
   * is already pinned at eye height and cannot be swung on a boom. Absent on the body
   * rigs themselves, which are the un-adjusted baseline; `applyCameraSettings` is what
   * puts it there.
   */
  lookPitchDeg?: number;
}

export const VEHICLE_RIG: CameraRig = {
  targetUp: 1.2,
  chaseBack: 16, chaseUp: 8.5,
  hoodForward: 1.2, hoodUp: 1.7,
  cockpitForward: 0.15, cockpitUp: 1.45,
  topDownUp: 48,
  orbitRadius: 19, orbitUp: 10,
  cinematicBack: 22, cinematicSide: 9, cinematicUp: 6,
};

export const FOOT_RIG: CameraRig = {
  targetUp: 1.1,
  chaseBack: 6.5, chaseUp: 3.4,
  hoodForward: 0.9, hoodUp: PERSON_EYE_Y,
  cockpitForward: 0.1, cockpitUp: PERSON_EYE_Y,
  topDownUp: 26,
  orbitRadius: 9, orbitUp: 4.6,
  cinematicBack: 10, cinematicSide: 4.5, cinematicUp: 2.8,
};

/**
 * Used for the chase camera specifically while the player is walking around inside a
 * moving bus: every other field is inherited from FOOT_RIG (this rig is only ever read
 * in chase mode aboard the bus, so the other fields are never consulted), with chase
 * distance/height pulled in to fit inside the cabin instead of the open street.
 */
export const INTERIOR_RIG: CameraRig = {
  ...FOOT_RIG,
  chaseBack: 2.2,
  chaseUp: 1.6,
};

/** Riding the horse: framed a bit farther back and higher than on-foot, since a rider's
 * eye height and the animal's own length both sit above a pedestrian's. */
export const HORSE_RIG: CameraRig = {
  ...FOOT_RIG,
  targetUp: 1.7,
  chaseBack: 8, chaseUp: 4.4,
  hoodForward: 1, hoodUp: 2.2,
  cockpitForward: 0.2, cockpitUp: 2.2,
  orbitRadius: 11, orbitUp: 5.6,
  cinematicBack: 12, cinematicSide: 5, cinematicUp: 3.4,
};

/** How far ahead the first-person modes aim. Far enough that the view reads as looking
 * down the road rather than at the bonnet, close enough to swing with the heading. */
const FIRST_PERSON_LOOK_AHEAD = 25;
/** Orbit rate, radians per millisecond. One revolution takes about 35 seconds — slow
 * enough to line up a shot, quick enough not to look stuck. */
const ORBIT_RATE = 0.00018;
/** Where the orbit is at `timeMs` 0: directly behind the body, which is where the camera
 * already is coming from chase — so entering orbit starts the sweep from the shot the
 * player was just looking at rather than from wherever the world clock had got to. The
 * caller supplies time *since orbit was entered* for this to mean anything; see
 * `resolveCameraPlacement`. */
const ORBIT_START_BEHIND = Math.PI;
/** Top-down looks straight down, which leaves the camera's up vector and its view
 * direction parallel and the resulting look-at matrix undefined. This nudge off the axis
 * is what keeps the horizon from flipping at random. */
const TOP_DOWN_NUDGE = 0.01;

export interface CameraPlacement {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/**
 * The camera's target pose this frame. `orbitElapsedMs` is named for the one mode that
 * reads it: orbit is the only mode that moves on its own, and it is defined from the
 * moment the mode was entered rather than from a world clock — against an absolute clock
 * it started at an arbitrary bearing, so entering orbit swept the shot round to a random
 * side before it began orbiting from there. Every other mode ignores it and is a pure
 * function of the body it follows. Freecam and the bus passenger seat are not here:
 * neither follows a body, so both are driven directly by the frame loop.
 *
 * Always returns fresh vectors. Callers ease toward them, so handing back shared
 * instances would mean the previous frame's target moved under the interpolation.
 */
export function resolveCameraPlacement(
  mode: CameraMode,
  rig: CameraRig,
  bodyPosition: THREE.Vector3,
  heading: number,
  orbitElapsedMs: number,
): CameraPlacement {
  const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const lookAt = bodyPosition.clone().setY(bodyPosition.y + rig.targetUp);
  const from = (offset: THREE.Vector3) => bodyPosition.clone().add(offset);
  // The first-person aim point, raised or dropped by the pitch dial. Expressed as a rise
  // over the fixed look-ahead run rather than as a rotation, so the aim stays the same
  // distance down the road at every pitch and only its height changes.
  const firstPersonLookAt = (eyeUp: number) => lookAt.clone()
    .add(forward.clone().multiplyScalar(FIRST_PERSON_LOOK_AHEAD))
    .setY(bodyPosition.y + eyeUp
      + FIRST_PERSON_LOOK_AHEAD * Math.tan(THREE.MathUtils.degToRad(rig.lookPitchDeg ?? 0)));

  switch (mode) {
    case 'hood':
      return {
        position: from(forward.clone().multiplyScalar(rig.hoodForward).setY(rig.hoodUp)),
        lookAt: firstPersonLookAt(rig.hoodUp),
      };
    case 'cockpit':
      return {
        position: from(forward.clone().multiplyScalar(rig.cockpitForward).setY(rig.cockpitUp)),
        lookAt: firstPersonLookAt(rig.cockpitUp),
      };
    case 'top-down':
      return { position: from(new THREE.Vector3(0, rig.topDownUp, TOP_DOWN_NUDGE)), lookAt };
    case 'orbit': {
      // Behind the body at timeMs 0, then round from there — see ORBIT_START_BEHIND.
      const angle = heading + ORBIT_START_BEHIND + orbitElapsedMs * ORBIT_RATE;
      return {
        position: from(new THREE.Vector3(
          Math.sin(angle) * rig.orbitRadius,
          rig.orbitUp,
          Math.cos(angle) * rig.orbitRadius,
        )),
        lookAt,
      };
    }
    case 'cinematic': {
      // +x is left of forward, so this side vector puts the camera off the right flank.
      const side = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
      return {
        position: from(forward.clone().multiplyScalar(-rig.cinematicBack)
          .add(side.multiplyScalar(rig.cinematicSide))
          .setY(rig.cinematicUp)),
        lookAt,
      };
    }
    default:
      return {
        position: from(forward.clone().multiplyScalar(-rig.chaseBack).setY(rig.chaseUp)),
        lookAt,
      };
  }
}

/** How long the opening establishing shot takes to descend from its overhead view
 * into the bus rig's cinematic flank. The unbroken move is deliberately slow enough
 * to establish the road and surrounding world before bringing the bus into focus. */
export const OPENING_CAM_INTRO_DURATION_MS = 15_000;

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * The scripted opening establishing shot: one continuous, eased move from the vehicle
 * top-down placement to its cinematic placement. Both endpoints use the same public
 * camera rigs as the corresponding selectable modes, so later tuning cannot leave the
 * intro resembling a different pair of shots. Returns null at the end for the runtime's
 * existing handoff into the passenger view.
 *
 * Deliberately built from the *un-adjusted* `VEHICLE_RIG`, not from the player's dials:
 * this is an authored shot with a composition of its own, and a player who had pulled the
 * camera in tight would otherwise open the game on a different film. Every selectable mode
 * goes through `applyCameraSettings`; this one is the documented exception.
 */
export function resolveOpeningIntroPlacement(
  busPosition: THREE.Vector3,
  busHeading: number,
  elapsedMs: number,
): CameraPlacement | null {
  if (elapsedMs >= OPENING_CAM_INTRO_DURATION_MS) return null;
  const progress = THREE.MathUtils.clamp(elapsedMs / OPENING_CAM_INTRO_DURATION_MS, 0, 1);
  const amount = easeInOut(progress);
  const topDown = resolveCameraPlacement('top-down', VEHICLE_RIG, busPosition, busHeading, 0);
  const cinematic = resolveCameraPlacement('cinematic', VEHICLE_RIG, busPosition, busHeading, 0);
  return {
    position: topDown.position.lerp(cinematic.position, amount),
    lookAt: topDown.lookAt.lerp(cinematic.lookAt, amount),
  };
}

/**
 * Elevation the follow booms are held between.
 *
 * The floor is above zero because a boom swung down to the horizontal puts the camera
 * inside whatever it is following and, on a slope, underground. The ceiling stops short of
 * vertical because a boom straight overhead leaves the look-at matrix's up vector parallel
 * to its view direction — the same degeneracy TOP_DOWN_NUDGE above exists for, and
 * top-down is the mode for that shot anyway.
 */
const MIN_BOOM_ELEVATION = THREE.MathUtils.degToRad(3);
const MAX_BOOM_ELEVATION = THREE.MathUtils.degToRad(78);

/**
 * Re-aims one camera boom and scales its reach: same bearing, elevation moved by
 * `pitchDeg` and clamped, the whole thing then multiplied by `distance`.
 *
 * Rotating rather than simply scaling the height is what makes the pitch dial mean
 * "higher up, looking further down" instead of "further away and higher", which is what
 * `distance` is already for. Returns the scale to apply to the horizontal reach and the
 * new height, so a boom with two horizontal components (cinematic's back *and* side) can
 * keep its bearing while changing its elevation.
 */
function pitchBoom(
  horizontal: number,
  up: number,
  pitchDeg: number,
  distance: number,
): { horizontalScale: number; up: number } {
  const radius = Math.hypot(horizontal, up);
  if (radius < 1e-6) return { horizontalScale: distance, up: up * distance };
  const elevation = THREE.MathUtils.clamp(
    Math.atan2(up, horizontal) + THREE.MathUtils.degToRad(pitchDeg),
    MIN_BOOM_ELEVATION,
    MAX_BOOM_ELEVATION,
  );
  const reach = radius * distance;
  return {
    horizontalScale: horizontal > 1e-6 ? (reach * Math.cos(elevation)) / horizontal : distance,
    up: reach * Math.sin(elevation),
  };
}

/**
 * The active rig with the player's dials applied — the value `resolveCameraPlacement`
 * should actually be handed.
 *
 * Lives here rather than in `cameraSettings.ts` because everything it has to know is rig
 * geometry: which fields are framing and which are eye positions, that cinematic's reach
 * is its back and side together, and where a boom's elevation has to stop (see
 * MIN/MAX_BOOM_ELEVATION, which justify themselves against TOP_DOWN_NUDGE a few lines up).
 * A rig knows how to be adjusted; a preference does not need to know what a boom is.
 *
 * `distance` scales the framing modes only. The first-person offsets (hood, cockpit) are
 * *eye positions*, not framing: scaling them would push the driver's head through the
 * windscreen at 2x and into the seat at 0.5x, so they are left exactly where the body's
 * own rig put them and take the pitch dial as a look angle instead (see `lookPitchDeg`).
 */
export function applyCameraSettings(rig: CameraRig, settings: CameraSettings): CameraRig {
  const { distance, pitch } = settings;
  const chase = pitchBoom(rig.chaseBack, rig.chaseUp, pitch, distance);
  const orbit = pitchBoom(rig.orbitRadius, rig.orbitUp, pitch, distance);
  // Cinematic's boom reaches back *and* to the side; its horizontal reach is the two
  // together, and scaling both by the same factor keeps the shot's bearing while the
  // elevation moves.
  const cinematic = pitchBoom(
    Math.hypot(rig.cinematicBack, rig.cinematicSide), rig.cinematicUp, pitch, distance,
  );
  return {
    ...rig,
    chaseBack: rig.chaseBack * chase.horizontalScale,
    chaseUp: chase.up,
    orbitRadius: rig.orbitRadius * orbit.horizontalScale,
    orbitUp: orbit.up,
    cinematicBack: rig.cinematicBack * cinematic.horizontalScale,
    cinematicSide: rig.cinematicSide * cinematic.horizontalScale,
    cinematicUp: cinematic.up,
    // Height is the only framing top-down has, so distance is the whole dial there — and
    // it never goes through a boom, which is why this multiply is on its own.
    topDownUp: rig.topDownUp * distance,
    lookPitchDeg: pitch,
  };
}

/**
 * Holds a placement's camera above the surface under it, leaving its look target alone.
 *
 * A boom swung down a rising slope, or over the edge of a bridge deck, ends up under the
 * ground it is meant to be looking across, where it sees the backs of the world's faces
 * and the shot goes black. Only the position moves: being pushed up off the ground should
 * not also tilt the shot.
 *
 * The height sampler is injected rather than imported so this stays what the rest of the
 * module is — pure, and testable with no scene and no physics world. Top-down is the one
 * mode that never needs it (it is already far above everything, by construction), and the
 * caller is what decides that rather than a mode check buried in here.
 */
export function clampPlacementAboveGround(
  placement: CameraPlacement,
  groundHeightAt: (x: number, z: number, maxHeight?: number) => number,
  clearance: number,
): CameraPlacement {
  const ground = groundHeightAt(placement.position.x, placement.position.z, placement.position.y + clearance);
  placement.position.y = Math.max(placement.position.y, ground + clearance);
  return placement;
}
