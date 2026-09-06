/**
 * The car-to-pill-to-swim state machine (backlog item 10).
 *
 * Pure and WebGL-free on purpose: every function here takes plain numbers/records and
 * returns plain numbers/records, so the whole entry -> sinking -> ejection -> swim ->
 * shore-exit sequence can be driven by the fixed 60Hz tick in fixedTimestep.ts and
 * verified without a renderer. "The same recorded input produces the same entry and
 * sinking sequence at different render frame rates" (see docs/BACKLOG.md item 10) is a
 * property of *these* functions being pure and only ever advanced by fixed ticks — the
 * runtime wiring's job is only to feed them consistently, never to also carry its own
 * copy of the timing logic.
 */

export type CarWaterPhase = 'dry' | 'entering' | 'disabled' | 'sinking' | 'submerged';

export interface CarWaterFootprintSample {
  x: number;
  z: number;
}

/**
 * Center plus all four wheel corners of the car's footprint, in world space, rotated by
 * heading. Sampling only the chassis center misses the common case of a car nosing into
 * water at an angle, where the front wheels are already submerged while the center point
 * is still over dry land (or the reverse, beaching on a shallow entry) — the backlog
 * calls this out explicitly ("footprint/wheel samples, not one center point").
 */
export function carFootprintSamples(
  position: { x: number; z: number },
  headingRadians: number,
  halfWheelbase: number,
  halfTrack: number,
): CarWaterFootprintSample[] {
  const cos = Math.cos(headingRadians);
  const sin = Math.sin(headingRadians);
  const corners: Array<[number, number]> = [
    [-halfTrack, -halfWheelbase],
    [halfTrack, -halfWheelbase],
    [-halfTrack, halfWheelbase],
    [halfTrack, halfWheelbase],
  ];
  const samples = corners.map(([localX, localZ]) => ({
    x: position.x + localX * cos - localZ * sin,
    z: position.z + localX * sin + localZ * cos,
  }));
  samples.push({ x: position.x, z: position.z });
  return samples;
}

/**
 * How many footprint samples are standing in water deeper than the car's floorpan.
 *
 * Asked as a *depth*, not as a height to compare a world Y against. This world has no
 * elevation model: a water sheet is drawn two centimetres above the same flat ground the
 * car drives on, so "is the water surface above the floorpan" is false in the middle of
 * the Baltic. What is actually known is how far from the shore a point is, which is what
 * `waterDepthAtXZ` (waterIndex.ts) turns into a depth — and a car is in the water exactly
 * when the water is deeper than the floor it would come in over.
 *
 * `waterDepthAt` returns null where there is no water polygon at the point at all.
 */
export function countSubmergedSamples(
  samples: readonly CarWaterFootprintSample[],
  waterDepthAt: (x: number, z: number) => number | null,
  floorHeight: number,
): number {
  let count = 0;
  for (const sample of samples) {
    const depth = waterDepthAt(sample.x, sample.z);
    if (depth !== null && depth > floorHeight) count += 1;
  }
  return count;
}

/** At least one wet wheel/footprint sample commits the car to an entry sequence. */
export const CAR_WATER_MIN_SAMPLES_TO_ENTER = 1;

export const CAR_WATER_ENTERING_TO_DISABLED_S = 0.5;
export const CAR_WATER_DISABLED_TO_SINKING_S = 0.8;
export const CAR_WATER_SINKING_TO_SUBMERGED_S = 2.5;
/** How far the chassis sinks below the water surface once fully submerged, in metres. */
export const CAR_WATER_FULL_SINK_DEPTH = 1.4;

export interface CarWaterState {
  phase: CarWaterPhase;
  /** Seconds spent in the current phase — reset on every transition, so a caller can
   * always tell how far through the current phase's own duration it is. */
  phaseElapsed: number;
  /** Metres the chassis has sunk below the water surface so far; 0 outside sinking/submerged. */
  sinkDepth: number;
}

export function initialCarWaterState(): CarWaterState {
  return { phase: 'dry', phaseElapsed: 0, sinkDepth: 0 };
}

/**
 * Advances the car-in-water state machine by exactly one fixed tick.
 *
 * `dry` and `entering` are reversible — a wheel that grazes the edge and drives back out
 * before disablement never commits the car to sinking. From `disabled` onward the car is
 * committed: no amount of the samples clearing (the chassis is already sinking, it isn't
 * going to un-sink) reverts the phase, only forward progress or an explicit recovery
 * (see docs/BACKLOG.md's "car recovery decided explicitly") resets it.
 */
export function stepCarWaterState(
  state: CarWaterState,
  submergedSamples: number,
  totalSamples: number,
  fixedDt: number,
): CarWaterState {
  void totalSamples;
  const wet = submergedSamples >= CAR_WATER_MIN_SAMPLES_TO_ENTER;
  switch (state.phase) {
    case 'dry':
      return wet ? { phase: 'entering', phaseElapsed: 0, sinkDepth: 0 } : state;

    case 'entering': {
      if (!wet) return initialCarWaterState();
      const phaseElapsed = state.phaseElapsed + fixedDt;
      return phaseElapsed >= CAR_WATER_ENTERING_TO_DISABLED_S
        ? { phase: 'disabled', phaseElapsed: 0, sinkDepth: 0 }
        : { phase: 'entering', phaseElapsed, sinkDepth: 0 };
    }

    case 'disabled': {
      const phaseElapsed = state.phaseElapsed + fixedDt;
      return phaseElapsed >= CAR_WATER_DISABLED_TO_SINKING_S
        ? { phase: 'sinking', phaseElapsed: 0, sinkDepth: 0 }
        : { phase: 'disabled', phaseElapsed, sinkDepth: 0 };
    }

    case 'sinking': {
      const phaseElapsed = state.phaseElapsed + fixedDt;
      const progress = Math.min(1, phaseElapsed / CAR_WATER_SINKING_TO_SUBMERGED_S);
      const sinkDepth = progress * CAR_WATER_FULL_SINK_DEPTH;
      return phaseElapsed >= CAR_WATER_SINKING_TO_SUBMERGED_S
        ? { phase: 'submerged', phaseElapsed: 0, sinkDepth: CAR_WATER_FULL_SINK_DEPTH }
        : { phase: 'sinking', phaseElapsed, sinkDepth };
    }

    case 'submerged':
      return { phase: 'submerged', phaseElapsed: state.phaseElapsed + fixedDt, sinkDepth: CAR_WATER_FULL_SINK_DEPTH };

    default:
      return state;
  }
}

/**
 * True on the tick the occupant must be put out of the car.
 *
 * Ejection is tied to the *start of sinking* rather than to disablement: the ~1.3s the car
 * spends flooding and dead in the water is the whole of the player's warning, and firing
 * on it would mean being thrown out the instant a wheel touched. It is a transition, not a
 * state, so re-entering a sinking car (which the re-entry cooldown already discourages)
 * does not eject again on the next tick.
 */
export function shouldEjectOccupant(previous: CarWaterPhase, next: CarWaterPhase): boolean {
  return next === 'sinking' && previous !== 'sinking';
}

/**
 * True once the car is going down rather than merely dead in the water.
 *
 * The dividing line between the physics simulation owning the car's pose and the game
 * placing it: up to here the chassis is still a body resting on its springs, coasting to a
 * stop; past it there is no ground under it and nothing for a suspension to push against,
 * and the sink is scripted.
 */
export function carIsSinking(phase: CarWaterPhase): boolean {
  return phase === 'sinking' || phase === 'submerged';
}

/** Drive input is only honoured while dry or still (reversibly) entering; disabled onward
 * removes control, per the backlog's "removes drive control, damps motion". */
export function driveControlEnabled(phase: CarWaterPhase): boolean {
  return phase === 'dry' || phase === 'entering';
}

/** Velocity multiplier applied per fixed tick once the car stops being drivable — damps
 * the car to a stop over disabled/sinking rather than leaving residual velocity carrying
 * a "dead" car through the water. 1 (no damping) while still driveable. */
export function driveVelocityDamping(phase: CarWaterPhase): number {
  switch (phase) {
    case 'disabled': return 0.9;
    case 'sinking': return 0.8;
    case 'submerged': return 0.6;
    default: return 1;
  }
}

/**
 * Searches for a safe point to eject the pill outside the car: rings of increasing radius
 * around the car, `directionCount` angles per ring, first point `isValid` accepts wins.
 * Returns null if nothing validates out to `maxRadius` — the caller's cue to fall back to
 * a recovery point instead of leaving the pill with nowhere safe to appear (the backlog's
 * "recovery fallback if no safe ejection point exists").
 */
export function findEjectionPoint(
  carPosition: { x: number; z: number },
  directionCount: number,
  radiusStart: number,
  radiusStep: number,
  maxRadius: number,
  isValid: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  for (let radius = radiusStart; radius <= maxRadius; radius += radiusStep) {
    for (let i = 0; i < directionCount; i += 1) {
      const angle = (i / directionCount) * Math.PI * 2;
      const x = carPosition.x + Math.cos(angle) * radius;
      const z = carPosition.z + Math.sin(angle) * radius;
      if (isValid(x, z)) return { x, z };
    }
  }
  return null;
}

export interface SwimState {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** Bounded horizontal speed for the swimming pill — noticeably slower than walking, so
 * swimming reads as its own distinct movement state rather than walking-with-a-splash. */
export const SWIM_MAX_SPEED = 3.2;
/** How quickly swim velocity approaches the requested input direction, 1/s. */
const SWIM_ACCEL = 6;

/**
 * One fixed tick of swim movement. `inputX`/`inputZ` are the raw (unnormalized,
 * unbounded) desired direction from keyboard/touch input; output velocity is clamped to
 * `SWIM_MAX_SPEED` regardless of how large the input was.
 */
export function stepSwim(state: SwimState, inputX: number, inputZ: number, fixedDt: number): SwimState {
  const inputLength = Math.hypot(inputX, inputZ);
  const targetX = inputLength > 1e-6 ? (inputX / inputLength) * SWIM_MAX_SPEED : 0;
  const targetZ = inputLength > 1e-6 ? (inputZ / inputLength) * SWIM_MAX_SPEED : 0;
  const blend = Math.min(1, SWIM_ACCEL * fixedDt);
  const vx = state.vx + (targetX - state.vx) * blend;
  const vz = state.vz + (targetZ - state.vz) * blend;
  return { x: state.x + vx * fixedDt, z: state.z + vz * fixedDt, vx, vz };
}

/**
 * Depth of water over the ground underfoot at which the pill starts swimming, and the
 * shallower depth at which it stands back up.
 *
 * Two thresholds, not one. At a single threshold a pill standing exactly at chest depth —
 * which is most of a gently shelving shore, and exactly where the player ends up wading
 * in — flips between swimming and walking every tick, and each flip changes both its
 * height and its speed. The gap is the hysteresis that makes the shore a place you cross
 * rather than a line you buzz on.
 */
export const SWIM_ENTER_DEPTH = 1.15;
export const SWIM_EXIT_DEPTH = 0.85;

/**
 * Where a body set down at a point ends up, and whether it is swimming there.
 *
 * The one rule for putting a body somewhere it was not standing a moment ago — an ejection
 * from a sinking car, a teleport, a spawn. Both of those used to place at a literal `y = 0`
 * or keep whatever height the body already had, which on this world's landuse extrusions
 * buries it and over open water leaves it standing on the bottom.
 *
 * `standY` is the surface underfoot (the ground, or the implied lake bed inside water) and
 * `waterY` is the water over it, or null where there is none. Uses the *exit* threshold
 * rather than the entry one: a body being placed has no momentum and no previous state to
 * be hysteretic about, and starting it swimming in water it could just about stand up in is
 * the harmless side of the choice — one tick of movement settles it either way.
 */
export function settleHeight(standY: number, waterY: number | null): { y: number; swimming: boolean } {
  const swimming = waterY !== null && waterY - standY > SWIM_EXIT_DEPTH;
  return { y: swimming ? swimSurfaceY(waterY) : standY, swimming };
}

/**
 * Where a floating body's origin sits relative to the surface, in metres.
 *
 * Negative: the origin of every playable body here is at its *feet* (see personModel's
 * PERSON_CENTER_Y), so placing it above the water line would float the whole 1.66m pill on
 * top of the sea like a boat. A swimmer is mostly under, with head and shoulders out.
 *
 * It is exactly `SWIM_ENTER_DEPTH` for a reason: a body wading out stands on the implied
 * bed, so its feet are already this far under at the moment the water gets deep enough to
 * swim in. Matching the two means the changeover has no step in it at all — the pill lifts
 * off the bottom instead of popping to a new height.
 */
export function swimSurfaceY(waterHeight: number): number {
  return waterHeight - SWIM_ENTER_DEPTH;
}

/** True once (x, z) is outside every water polygon — `waterHeightAt` returning null is
 * exactly "no water ring contains this point", which is the shore-exit condition. */
export function isAtShore(
  x: number,
  z: number,
  waterHeightAt: (x: number, z: number) => number | null,
): boolean {
  return waterHeightAt(x, z) === null;
}

/** How long after being ejected the pill must wait before it may re-enter the car —
 * prevents the ejection point (which sits just outside the car) from being close enough
 * that the same "enter vehicle" input immediately puts the player back in a car that is
 * still sinking. */
export const REENTRY_COOLDOWN_S = 1.5;

export function reentryAllowed(secondsSinceEjection: number): boolean {
  return secondsSinceEjection >= REENTRY_COOLDOWN_S;
}

/** How fast the body settles onto the surface it is floating on, in seconds. Slow enough
 * to read as buoyancy lifting it rather than as a snap to a new height. */
const SWIM_SURFACE_TAU = 0.25;

/** Slowest a body wades: knee-deep water barely slows you, chest-deep nearly stops you,
 * and past that you are swimming and this no longer applies. */
const MIN_WADE_FACTOR = 0.45;

/**
 * Walking-speed multiplier for standing in water too shallow to swim in. Without it the
 * only thing the shallows do is change the pill's height, and wading in reads as walking
 * onto a blue floor.
 */
export function wadeSpeedFactor(depth: number): number {
  if (depth <= 0) return 1;
  const t = Math.min(1, depth / SWIM_ENTER_DEPTH);
  return 1 - (1 - MIN_WADE_FACTOR) * t;
}

/** A body that may be in water: whether it is currently swimming, and the swim velocity
 * it carries between ticks. Held by the runtime per playable body; `stepWaterMovement`
 * is the only thing that writes it. */
export interface SwimBody {
  swimming: boolean;
  vx: number;
  vz: number;
}

export function initialSwimBody(): SwimBody {
  return { swimming: false, vx: 0, vz: 0 };
}

export interface WaterMovement {
  /** Where the body wants to be this tick, before world collision has its say. */
  x: number;
  z: number;
  swimming: boolean;
  /** Ground speed the HUD reads, m/s. */
  speed: number;
}

/**
 * One fixed tick of horizontal motion for a playable body, whether it is on dry land, in
 * the shallows, or swimming — and the single place the swimming/walking decision is made.
 *
 * `body` is updated in place: the caller keeps one per playable body and hands the same
 * one back every tick, which is what carries swim momentum (and the hysteresis state)
 * across ticks. Movement is still requested as heading + throttle, the same tank layout
 * every other mode uses, so the controls do not change meaning when you swim out of your
 * depth — only what they produce does.
 *
 * `waterHeight` is null where no water polygon covers the body at all; `groundY` is the
 * surface it would be standing on there.
 */
export function stepWaterMovement(
  body: SwimBody,
  position: { x: number; z: number },
  heading: number,
  throttle: number,
  walkPace: number,
  waterHeight: number | null,
  groundY: number,
  fixedDt: number,
): WaterMovement {
  const depth = waterHeight === null ? 0 : Math.max(0, waterHeight - groundY);
  body.swimming = waterHeight !== null
    && depth > (body.swimming ? SWIM_EXIT_DEPTH : SWIM_ENTER_DEPTH);

  if (!body.swimming) {
    // Wading or dry. Swim momentum is dropped rather than decayed: standing up in the
    // shallows is a change of medium, and carrying a stroke's velocity onto your feet
    // would slide the pill up the beach.
    body.vx = 0;
    body.vz = 0;
    const pace = walkPace * wadeSpeedFactor(depth);
    return {
      x: position.x + Math.sin(heading) * pace * throttle * fixedDt,
      z: position.z + Math.cos(heading) * pace * throttle * fixedDt,
      swimming: false,
      speed: pace * Math.abs(throttle),
    };
  }

  const stroke = stepSwim(
    { x: position.x, z: position.z, vx: body.vx, vz: body.vz },
    Math.sin(heading) * throttle,
    Math.cos(heading) * throttle,
    fixedDt,
  );
  body.vx = stroke.vx;
  body.vz = stroke.vz;
  return { x: stroke.x, z: stroke.z, swimming: true, speed: Math.hypot(stroke.vx, stroke.vz) };
}

/**
 * Where a swimming body's origin should be this tick: eased towards the floating height
 * rather than pinned to it, so entering the water is a body settling into it and a passing
 * change in the surface underneath does not teleport it.
 */
export function swimBodyY(currentY: number, waterHeight: number, fixedDt: number): number {
  const target = swimSurfaceY(waterHeight);
  return currentY + (target - currentY) * (1 - Math.exp(-fixedDt / SWIM_SURFACE_TAU));
}
