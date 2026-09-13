/**
 * The opening cinematic's shot table, and the pure director that resolves it.
 *
 * Three scenes, each a different *kind* of camera rather than a different set of numbers
 * for one camera:
 *
 * 1. a locked-off tripod beside a forest road at dusk, which the bus crosses right to left;
 * 2. a directed follow through the weave, close and low so the bends read;
 * 3. a rig bolted to the bus, aimed forward, with a front wheel spinning in the right of
 *    frame. This is also the shot the world swap hides inside — see the handoff in
 *    svartaksiRuntime.tsx — which is why it frames almost nothing but bus.
 *
 * None of this goes through `cameraRig.ts`. That module answers "where does the *player's*
 * camera sit given the body it follows", and every mode in it is a rig the player can
 * select and adjust. A cinematic shot is the opposite: fixed, authored, and not the
 * player's to change. `'intro'` is deliberately absent from CAMERA_MODES for the same
 * reason — that list is the C-cycle vocabulary and is persisted to user settings.
 *
 * Pure by design: no THREE.Scene, no refs, no DOM. The frame loop hands in the bus's pose
 * and gets back a pose to write. That is what lets the framing claims in the shot
 * descriptions above — "right to left", "in the right of frame" — be *tested* rather than
 * eyeballed, via `projectToNdc` below.
 */
import * as THREE from 'three';
import { BUS_DIMENSIONS } from './busGeometry';

/**
 * Time of day the intro is lit at, in hours.
 *
 * "Late evening": the sky still has some blue in it rather than being flat night. But the
 * headlights are the point of scene 1, and they are not a free consequence of a late hour
 * — `setBusNightFactor` (busModel.ts) switches them on only above a nightFactor of 0.35.
 * 21.5 clears that with margin while leaving the horizon readable behind the treeline.
 * The test asserts the threshold rather than trusting this comment.
 */
export const INTRO_HOUR = 21.5;

/**
 * Speed the bus is already doing when the cinematic opens, in m/s.
 *
 * Scene 1 is a bus crossing frame, not a bus pulling away: at BUS_ACCEL (1.15 m/s²) it
 * would take nearly eleven seconds to reach road speed, which is longer than the shot.
 * `advanceRideSpeed` takes the current speed as an argument, so the ride simply starts at
 * speed instead of from rest.
 */
export const INTRO_START_SPEED = 12.5;

export type IntroShotKind = 'locked-off' | 'follow' | 'bolted';

interface IntroShotBase {
  id: string;
  kind: IntroShotKind;
  /** How long the shot holds, in seconds. */
  seconds: number;
  /** Vertical field of view in degrees, applied via `updateCameraFov`. */
  fov: number;
}

/** A camera on a tripod: it does not move, and it does not care where the bus is. */
export interface LockedOffShot extends IntroShotBase {
  kind: 'locked-off';
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
}

/**
 * A directed follow. Offsets are in the bus's own frame — `back` behind it, `side` to its
 * left, `up` above — but unlike the player's chase camera they are authored per shot and
 * drift across it on a fixed schedule, so the move is the same every time it plays.
 */
export interface FollowShot extends IntroShotBase {
  kind: 'follow';
  back: number;
  /** Lateral offset at the start and end of the shot; the camera eases between them. */
  sideFrom: number;
  sideTo: number;
  upFrom: number;
  upTo: number;
  /** Height above the bus's origin that the camera aims at. */
  targetUp: number;
}

/** A rig bolted rigidly to the bus. Both points are in the bus's frame, so the shot is
 * completely still relative to the vehicle however the vehicle moves. */
export interface BoltedShot extends IntroShotBase {
  kind: 'bolted';
  offset: { x: number; y: number; z: number };
  aim: { x: number; y: number; z: number };
}

export type IntroShot = LockedOffShot | FollowShot | BoltedShot;

/**
 * Where scene 1's tripod stands and what it looks at.
 *
 * Every number here is answerable from the geometry rather than taste. The road runs along
 * −x at z = 2000 (introStage.ts), so a camera on the +z side of it sees a westbound bus
 * enter from the right — that is the requested direction of travel, and it is fixed by
 * which side of the road the tripod is on, not by the look-at.
 *
 * The distance and the FOV together set how long the bus is in shot: at 46m with a 32°
 * vertical FOV the frame is about 47m wide at the road on a 16:9 display, which a bus
 * doing 12.5 m/s crosses in ~4.6s, leaving ~1.7s of empty road at each end of the 8s shot.
 * That padding is the "time padding at the beginning and end" the scene asks for, and it
 * is what the framing test measures — including at 21:9, where the wider frame eats into
 * it but does not close it.
 */
const TRIPOD_DISTANCE = 46;
const TRIPOD_LOOK_X = 2_180;

/**
 * The shot table.
 *
 * Durations are not free-floating: they are cut against the bus's *measured* progress
 * along the authored road, because the bus's speed is set by that road's bend radii and
 * not by this file. Scene 1 is the opening straight, scene 2 spans the weave end to end,
 * and scene 3 rides the run-out. `tests/svartaksi/introSequence.test.ts` re-derives those
 * marks from `buildRideProfile` and fails if the road and this table drift apart.
 */
export const INTRO_SHOTS: readonly IntroShot[] = [
  {
    id: 'scene1-tripod',
    kind: 'locked-off',
    seconds: 8,
    fov: 32,
    // Slightly above standing height, looking a little down at the carriageway: high
    // enough that the road reads as a surface rather than an edge-on line, low enough
    // that the trees still tower over the frame.
    position: { x: TRIPOD_LOOK_X, y: 2.6, z: 2_000 + TRIPOD_DISTANCE },
    lookAt: { x: TRIPOD_LOOK_X, y: 1.3, z: 2_000 },
  },
  {
    id: 'scene2-follow',
    kind: 'follow',
    // Spans the weave with a little straight either side of it — the bus is already
    // leaning into the first bend when the cut lands, rather than arriving at it.
    seconds: 16,
    fov: 38,
    // Close and low. A long lens from far back would flatten the bends into a straight
    // line; this is near enough that the road swings visibly through frame.
    back: 15,
    // The camera drifts from the bus's left to its right across the shot, so it is on the
    // outside of each bend in turn and the weave is seen from both sides rather than
    // from a fixed quarter.
    sideFrom: 7.5,
    sideTo: -7.5,
    // And rises slightly, opening the view out over the bus toward the road ahead.
    upFrom: 3.2,
    upTo: 4.6,
    targetUp: 1.9,
  },
  {
    id: 'scene3-wheel',
    kind: 'bolted',
    seconds: 8,
    // Wide: the camera is barely a metre from the bodywork, and anything longer would
    // fill the frame with flank and lose both the wheel and the road ahead.
    fov: 52,
    // Outboard of the *left* flank (the body is 1.3m to each side, and +x is left of
    // forward), at hub height, a metre and a half behind the front axle.
    //
    // Left, counter-intuitively, is what puts a wheel on the *right* of the frame. A
    // forward-looking camera's screen-right points across the bus toward its far side, so
    // a camera mounted outboard of a wheel sees that wheel inboard of its aim — on the
    // left of frame. Mounting on the near flank and framing the near wheel is the only
    // arrangement that gives the requested shot while still looking down the road.
    offset: { x: 2.2, y: 1.15, z: 2.2 },
    // Aimed forward and slightly inboard, which is what holds the wheel in the lower right
    // while leaving the road ahead visible past it.
    aim: { x: 0.4, y: 0.15, z: 18 },
  },
];

/**
 * The shot the handoff to live gameplay happens inside.
 *
 * Named rather than indexed because the whole design rests on it being *this* shot: the
 * bolted rig frames almost nothing but bodywork, so the world can be swapped underneath it
 * without the player seeing the change. A skip request winds the cinematic forward to here
 * rather than cutting out of it.
 */
export const INTRO_HANDOFF_SHOT = 'scene3-wheel';

/** Total running time of the cinematic, in seconds. */
export const INTRO_DURATION = INTRO_SHOTS.reduce((total, shot) => total + shot.seconds, 0);

/**
 * The front wheel scene 3 frames, in the bus's own frame — the subject of the shot, and
 * the thing its framing test projects. Derived from the geometry sheet rather than
 * restated, so a change to the bus's track or axle position moves the assertion with it
 * instead of silently invalidating it.
 *
 * It is the wheel on the bus's left (+x), which is the one that appears on the *right* of
 * the frame — see the mounting note on scene 3's offset.
 */
export const FRAMED_WHEEL_LOCAL = {
  x: BUS_DIMENSIONS.track / 2,
  y: BUS_DIMENSIONS.wheelRadius,
  z: BUS_DIMENSIONS.frontAxleZ,
};

/** Which shot is on screen at `elapsed` seconds, and how far into it we are. Returns null
 * once the cinematic has run out, which is the frame loop's cue to hand over. */
export function introShotAt(elapsed: number): { shot: IntroShot; index: number; local: number } | null {
  if (!(elapsed >= 0)) return { shot: INTRO_SHOTS[0], index: 0, local: 0 };
  let start = 0;
  for (let index = 0; index < INTRO_SHOTS.length; index += 1) {
    const shot = INTRO_SHOTS[index];
    if (elapsed < start + shot.seconds) return { shot, index, local: elapsed - start };
    start += shot.seconds;
  }
  return null;
}

/** Seconds from the start of the cinematic to the first frame of `id`. */
export function introShotStart(id: string): number {
  let start = 0;
  for (const shot of INTRO_SHOTS) {
    if (shot.id === id) return start;
    start += shot.seconds;
  }
  return Number.NaN;
}

/** The bus's pose, in the terms the director needs it: where the body is and which way it
 * points. Matches what the frame loop already has to hand from `sampleRide`. */
export interface BusPose {
  position: THREE.Vector3;
  heading: number;
}

export interface IntroPlacement {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  fov: number;
}

/** Smoothstep, so a drifting follow eases in and out of its move instead of starting and
 * stopping abruptly at the cut. */
function ease(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Resolves one shot to a camera pose.
 *
 * Always returns fresh vectors, the same contract `resolveCameraPlacement` keeps and for
 * the same reason: the caller may ease toward them, and a shared instance would move under
 * the interpolation. (The intro itself does *not* ease — see the runtime's intro branch —
 * but that is the caller's decision to make, not this module's to foreclose.)
 */
export function resolveIntroShot(shot: IntroShot, local: number, bus: BusPose): IntroPlacement {
  // The bus's own axes. Forward is the codebase convention (`cameraRig.ts`); left is that
  // turned a quarter turn, which is also what an Object3D at rotation.y = heading maps its
  // local +x to — so `offset.x` here means the same thing as a bus-local x anywhere else.
  const forwardX = Math.sin(bus.heading);
  const forwardZ = Math.cos(bus.heading);
  const leftX = Math.cos(bus.heading);
  const leftZ = -Math.sin(bus.heading);

  if (shot.kind === 'locked-off') {
    return {
      position: new THREE.Vector3(shot.position.x, shot.position.y, shot.position.z),
      lookAt: new THREE.Vector3(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z),
      fov: shot.fov,
    };
  }

  if (shot.kind === 'follow') {
    const t = ease(local / shot.seconds);
    const side = shot.sideFrom + (shot.sideTo - shot.sideFrom) * t;
    const up = shot.upFrom + (shot.upTo - shot.upFrom) * t;
    return {
      position: new THREE.Vector3(
        bus.position.x - forwardX * shot.back + leftX * side,
        bus.position.y + up,
        bus.position.z - forwardZ * shot.back + leftZ * side,
      ),
      lookAt: new THREE.Vector3(bus.position.x, bus.position.y + shot.targetUp, bus.position.z),
      fov: shot.fov,
    };
  }

  return {
    position: busLocalToWorld(bus, shot.offset, forwardX, forwardZ, leftX, leftZ),
    lookAt: busLocalToWorld(bus, shot.aim, forwardX, forwardZ, leftX, leftZ),
    fov: shot.fov,
  };
}

/** Bus-frame point to world. Shared by the bolted shot and by the tests that need to know
 * where a wheel actually is. */
export function busLocalToWorld(
  bus: BusPose,
  local: { x: number; y: number; z: number },
  forwardX = Math.sin(bus.heading),
  forwardZ = Math.cos(bus.heading),
  leftX = Math.cos(bus.heading),
  leftZ = -Math.sin(bus.heading),
): THREE.Vector3 {
  return new THREE.Vector3(
    bus.position.x + leftX * local.x + forwardX * local.z,
    bus.position.y + local.y,
    bus.position.z + leftZ * local.x + forwardZ * local.z,
  );
}

/**
 * Where a world point lands in the frame, in normalized device coordinates: x and y each
 * run −1 (left, bottom) to +1 (right, top), and `ahead` is false when the point is behind
 * the camera, where the projection is meaningless.
 *
 * This exists so the shot descriptions can be checked rather than asserted. "Enters from
 * the right and exits to the left" and "the wheel is in the right of the frame" are claims
 * about `x`, and without this they would be claims nothing could verify.
 *
 * Rebuilt here rather than borrowed from a THREE.Camera because it has to run in a pure
 * test with no renderer, and because the basis is exactly the one `Matrix4.lookAt` builds:
 * z away from the subject, x = up × z, y = z × x.
 */
export function projectToNdc(
  placement: { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number },
  aspect: number,
  point: THREE.Vector3,
): { x: number; y: number; ahead: boolean } {
  const zAxis = new THREE.Vector3().subVectors(placement.position, placement.lookAt).normalize();
  const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  const relative = new THREE.Vector3().subVectors(point, placement.position);
  // The camera looks down its own −z, so depth is the negated component.
  const depth = -relative.dot(zAxis);
  if (depth <= 1e-6) return { x: 0, y: 0, ahead: false };
  const tanHalfV = Math.tan(THREE.MathUtils.degToRad(placement.fov) / 2);
  return {
    x: relative.dot(xAxis) / (depth * tanHalfV * aspect),
    y: relative.dot(yAxis) / (depth * tanHalfV),
    ahead: true,
  };
}

/**
 * True when the bus is entirely outside the frame — what "time padding at the beginning
 * and end" of scene 1 means operationally.
 *
 * Tested against the bus's two extreme corners along its length rather than its centre: a
 * bus is 11m long, and a centre point clears the frame edge a full half-length before the
 * vehicle actually does.
 */
export function busIsOffCamera(
  placement: IntroPlacement,
  aspect: number,
  bus: BusPose,
): boolean {
  const half = BUS_DIMENSIONS.length / 2;
  for (const z of [half, -half]) {
    const corner = busLocalToWorld(bus, { x: 0, y: BUS_DIMENSIONS.height / 2, z });
    const ndc = projectToNdc(placement, aspect, corner);
    if (ndc.ahead && Math.abs(ndc.x) <= 1) return false;
  }
  return true;
}
