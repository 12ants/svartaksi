/**
 * The bus's dimension sheet and its steering geometry, in one framework-agnostic module
 * (no THREE, no DOM) so both can be unit-tested without a WebGL context and consumed by
 * everything that needs to agree on the bus's shape: the shell in busModel.ts, the
 * suspension in busSuspension.ts, the route speed profile in busRouting.ts, and the
 * runtime's placement of the body along a route.
 *
 * `BUS_DIMENSIONS` is the approved measurement sheet (backlog item 2, bullet 1) — the
 * authored numbers a real bus of this class would carry, rounded to a metre or a
 * centimetre where a real spec sheet would be. Everything derived from wheelbase and
 * track (minimum turn radius, maximum steering angle) is computed by the functions below
 * rather than tuned by eye, per bullet 2.
 */

/** Overall shape and running-gear layout. Lengths in metres, angles in radians. */
export interface BusDimensions {
  /** Overall body length, bumper to bumper. */
  length: number;
  /** Overall body width, skin to skin. */
  width: number;
  /** Overall body height, road to roof. */
  height: number;
  /** Distance between the front and rear axles. */
  wheelbase: number;
  /** Front bumper to front axle. */
  frontOverhang: number;
  /** Rear axle to rear bumper. */
  rearOverhang: number;
  /** Centre-to-centre spacing of the single front wheels (and the outer pair of the
   * rear duals). This is the track Ackermann geometry is computed against. */
  track: number;
  /** Centre-to-centre spacing of the inner pair of the rear duals. */
  innerTrack: number;
  /** Rolling radius of every tyre — all six run the same size. */
  wheelRadius: number;
  /** Saloon floor height above the road. */
  floorHeight: number;
  /** Height of every axle above the road at rest. */
  axleHeight: number;
  /** Forward (+z) position of the front axle in the body frame. */
  frontAxleZ: number;
  /** Forward (+z) position of the rear axle in the body frame. */
  rearAxleZ: number;
  /** Nearside doorway, back and front edge of the clear opening. */
  doorBackZ: number;
  doorFrontZ: number;
  /** How many rows of saloon seating the shell is built for. */
  seatRows: number;
  /** Half-extents of a box that encloses the whole body — what a caller doing coarse
   * collision or culling against the bus should use rather than measuring the shell. */
  collisionHalfExtents: { x: number; y: number; z: number };
  /** Minimum radius, measured at the rear axle centreline, the bus can turn at full
   * lock. Design input: maxSteerAngle is derived from this and the wheelbase, not the
   * other way round — see computeMaxSteerAngle. */
  minTurnRadius: number;
  /** Lock-to-lock limit on the (virtual, bicycle-model) front wheel angle, in radians.
   * Derived from wheelbase and minTurnRadius by computeMaxSteerAngle — see below. */
  maxSteerAngle: number;
}

const WHEELBASE = 7.4;
const FRONT_AXLE_Z = 3.75;
const REAR_AXLE_Z = FRONT_AXLE_Z - WHEELBASE;
const HALF_LENGTH = 5.5;
const HALF_WIDTH = 1.3;

/**
 * Minimum turn radius at the rear axle, in metres. Authored against the class of vehicle
 * this is (a long single-deck city bus, ~11m), not tuned to reproduce a steering angle
 * picked by eye — a 12m bus's quoted kerb-to-kerb turning circle is typically in the
 * 21-23m range, which corresponds to a centreline (rear-axle) radius a little under half
 * that once track width and overhang sweep are taken out.
 */
const MIN_TURN_RADIUS = 9.5;

/**
 * Maximum steering angle a rear-axle turn radius of `minTurnRadius` implies for a vehicle
 * of this wheelbase, from the standard bicycle-model relation R = wheelbase / tan(delta).
 */
export function computeMaxSteerAngle(wheelbase: number, minTurnRadius: number): number {
  return Math.atan(wheelbase / minTurnRadius);
}

/** Inverse of computeMaxSteerAngle: the rear-axle turn radius a given lock implies. */
export function computeMinTurnRadius(wheelbase: number, maxSteerAngle: number): number {
  return wheelbase / Math.tan(maxSteerAngle);
}

export const BUS_DIMENSIONS: BusDimensions = {
  length: HALF_LENGTH * 2,
  width: HALF_WIDTH * 2,
  height: 3.06,
  wheelbase: WHEELBASE,
  frontOverhang: HALF_LENGTH - FRONT_AXLE_Z,
  rearOverhang: HALF_LENGTH + REAR_AXLE_Z,
  track: 2.04,
  innerTrack: 1.44,
  wheelRadius: 0.52,
  floorHeight: 0.61,
  axleHeight: 0.55,
  frontAxleZ: FRONT_AXLE_Z,
  rearAxleZ: REAR_AXLE_Z,
  doorBackZ: -3.1,
  doorFrontZ: -1.3,
  seatRows: 7,
  collisionHalfExtents: { x: HALF_WIDTH, y: 1.53, z: HALF_LENGTH },
  minTurnRadius: MIN_TURN_RADIUS,
  maxSteerAngle: computeMaxSteerAngle(WHEELBASE, MIN_TURN_RADIUS),
};

/** Steer angle of the bus's left and right front wheels, in radians. Both share the
 * sign of the commanded (bicycle-model) angle; they differ in magnitude. */
export interface AckermannAngles {
  left: number;
  right: number;
}

/**
 * Splits one commanded "virtual centre wheel" steering angle into the distinct angles the
 * left and right front wheels must take so both point at the same turn centre (standard
 * Ackermann steering geometry). `centerAngle` is positive turning left, matching the
 * convention setBusSteer already uses.
 *
 * On the inside of the turn a wheel is closer to the turn centre, so it must point
 * sharper than the virtual centre wheel; the outside wheel points shallower. At
 * centerAngle = 0 both wheels point straight ahead.
 */
export function computeAckermannAngles(
  centerAngle: number,
  wheelbase: number,
  track: number,
): AckermannAngles {
  if (centerAngle === 0) return { left: 0, right: 0 };
  const sign = Math.sign(centerAngle);
  // Guard against a caller passing an angle at or past the point where the inner wheel's
  // turn circle would pass through the axle itself — physically unreachable, and a
  // division here would blow up rather than saturate.
  const rawRadius = wheelbase / Math.tan(Math.abs(centerAngle));
  const radius = Math.max(rawRadius, track / 2 + 1e-6);
  const innerAngle = Math.atan(wheelbase / (radius - track / 2));
  const outerAngle = Math.atan(wheelbase / (radius + track / 2));
  // Positive centerAngle turns left: the left wheel is then the inner one.
  return sign > 0
    ? { left: innerAngle, right: outerAngle }
    : { left: -outerAngle, right: -innerAngle };
}

/** A position and heading in the world's local (x, z) plane. Heading follows the
 * renderer's convention: forward is (sin(heading), 0, cos(heading)). */
export interface VehiclePose {
  x: number;
  z: number;
  heading: number;
}

/**
 * One kinematic-bicycle-model integration step: advances the vehicle's REAR axle by
 * `speed * dt` along its current heading, and turns that heading at the rate a front
 * wheel steered by `steerAngle` (relative to the body) would impose — the standard
 * relation yaw-rate = (speed / wheelbase) * tan(steerAngle).
 *
 * This is the ground truth for what "the rear axle cuts inside the front axle" means: it
 * is the rear axle, not the front, whose position is being integrated directly, and the
 * front axle (frontAxleFromRear below) simply sits one wheelbase ahead of it along the
 * body's own heading — never sampled from the road a wheelbase back, which is why it
 * ends up outside the rear axle's own path through a constant-radius turn (see
 * busGeometry.test.ts).
 */
export function stepBicycleModel(
  rear: VehiclePose,
  steerAngle: number,
  speed: number,
  wheelbase: number,
  dt: number,
): VehiclePose {
  const yawRate = (speed / wheelbase) * Math.tan(steerAngle);
  const heading = rear.heading + yawRate * dt;
  return {
    x: rear.x + Math.sin(rear.heading) * speed * dt,
    z: rear.z + Math.cos(rear.heading) * speed * dt,
    heading,
  };
}

/** The front axle position implied by a rear axle pose and the body's wheelbase. */
export function frontAxleFromRear(rear: VehiclePose, wheelbase: number): { x: number; z: number } {
  return {
    x: rear.x + Math.sin(rear.heading) * wheelbase,
    z: rear.z + Math.cos(rear.heading) * wheelbase,
  };
}

/**
 * Offsets a sampled road point sideways by `laneOffset` along the local perpendicular of
 * `heading`, giving one axle's position on its own side of the carriageway. Pure version
 * of the offset svartaksiRuntime applies to keep an 11m bus from straddling both lanes of the
 * road it is routed down.
 */
export function offsetAlongHeading(
  point: { x: number; z: number },
  heading: number,
  laneOffset: number,
): VehiclePose {
  return {
    x: point.x + Math.cos(heading) * laneOffset,
    z: point.z - Math.sin(heading) * laneOffset,
    heading,
  };
}

/** Body centre and heading implied by a front and rear axle pose — the midpoint of the
 * chord between them, facing from rear to front. Falls back to the front pose's own
 * heading when the two axles coincide (nothing to take a heading from). */
export function chassisPoseFromAxles(front: VehiclePose, rear: VehiclePose): VehiclePose {
  const span = Math.hypot(front.x - rear.x, front.z - rear.z);
  return {
    x: (front.x + rear.x) / 2,
    z: (front.z + rear.z) / 2,
    heading: span > 1e-6 ? Math.atan2(front.x - rear.x, front.z - rear.z) : front.heading,
  };
}
