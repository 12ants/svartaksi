/**
 * Suspension for the bus, which is not a free body: it follows a routed path, so its
 * position and heading are decided by the route rather than by physics (see the chassis
 * comment in svartaksiRuntime). What is *not* decided by the route is how it sits on its
 * springs, and that is what this does.
 *
 * Six wheels, four corners. Each corner probes the ground under it, and the body is
 * carried on a second-order spring towards the pose those four probes describe: heave
 * from their average height, pitch from the difference front to rear, roll from the
 * difference side to side. Because it is a spring with its own velocity rather than a
 * lerp, a kerb the front wheels drop off makes the whole bus dip, rebound, and settle,
 * which is what a bus does — a lerp would slide it down and stop dead.
 *
 * The wheels then travel independently within the arches to stay on the ground the body
 * has been carried away from. That is the visible half of a suspension: the body stays
 * roughly level while the wheels move, rather than the wheels being welded to a body that
 * pivots around them.
 */

export interface SpringState {
  value: number;
  velocity: number;
}

export function createSpring(value = 0): SpringState {
  return { value, velocity: 0 };
}

/**
 * One semi-implicit Euler step of a damped harmonic oscillator: acceleration is the
 * spring pulling towards `target` minus the damper resisting the current velocity.
 *
 * Semi-implicit (velocity updated first, then used to move the value) rather than
 * explicit Euler, because the explicit form gains energy at stiff settings and turns a
 * settling bus into an oscillating one.
 */
export function advanceSpring(
  state: SpringState,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): SpringState {
  const acceleration = (target - state.value) * stiffness - state.velocity * damping;
  const velocity = state.velocity + acceleration * dt;
  return { value: state.value + velocity * dt, velocity };
}

export interface BusSuspensionState {
  /** Vertical body movement, metres. */
  heave: SpringState;
  /** Body pitch, radians. Positive lifts the nose. */
  pitch: SpringState;
  /** Body roll, radians. Positive lifts the left side (+x). */
  roll: SpringState;
}

export function createBusSuspension(): BusSuspensionState {
  return { heave: createSpring(), pitch: createSpring(), roll: createSpring() };
}

/** Ground height under each corner, in metres, in the same frame the bus is placed in. */
export interface CornerHeights {
  frontLeft: number;
  frontRight: number;
  rearLeft: number;
  rearRight: number;
}

export interface BusSuspensionConfig {
  /** Distance between the axles, and between the wheels across one axle. */
  wheelbase: number;
  track: number;
  /** Spring rate and damping, per axis. A bus is softly sprung and heavily damped:
   * it wallows slowly rather than bouncing. */
  heaveStiffness: number;
  heaveDamping: number;
  angularStiffness: number;
  angularDamping: number;
}

export const BUS_SUSPENSION_CONFIG: BusSuspensionConfig = {
  wheelbase: 7.4,
  track: 2.04,
  heaveStiffness: 42,
  heaveDamping: 9.5,
  angularStiffness: 34,
  angularDamping: 8.5,
};

/**
 * Advances the body's three degrees of freedom towards the pose the four corner probes
 * describe. Angles use the small-angle approximation — over a 7.4m wheelbase, a step big
 * enough for the difference to matter is one the bus could not drive over anyway.
 */
export function advanceBusSuspension(
  state: BusSuspensionState,
  corners: CornerHeights,
  dt: number,
  config: BusSuspensionConfig = BUS_SUSPENSION_CONFIG,
): BusSuspensionState {
  const front = (corners.frontLeft + corners.frontRight) / 2;
  const rear = (corners.rearLeft + corners.rearRight) / 2;
  const left = (corners.frontLeft + corners.rearLeft) / 2;
  const right = (corners.frontRight + corners.rearRight) / 2;
  return {
    heave: advanceSpring(state.heave, (front + rear) / 2, config.heaveStiffness, config.heaveDamping, dt),
    // A rotation about +x lowers the +z (front) end, so lifting the nose when the front
    // wheels are on higher ground is a *negative* pitch by that convention — which is why
    // this reads rear-minus-front rather than the other way round.
    pitch: advanceSpring(
      state.pitch, (rear - front) / config.wheelbase,
      config.angularStiffness, config.angularDamping, dt,
    ),
    roll: advanceSpring(
      state.roll, (left - right) / config.track,
      config.angularStiffness, config.angularDamping, dt,
    ),
  };
}

/**
 * How far one wheel's axle must move, relative to the body, to keep its tyre on the
 * ground — the gap between the ground under it and the body surface that has been carried
 * away from that ground. Clamped to the arch, past which the wheel simply leaves the
 * road or bottoms out, exactly as a real one does.
 */
export function wheelTravel(
  state: BusSuspensionState,
  wheelX: number,
  wheelZ: number,
  groundHeight: number,
  maxTravel = 0.13,
): number {
  const bodyHeight = state.heave.value + state.roll.value * wheelX - state.pitch.value * wheelZ;
  return Math.max(-maxTravel, Math.min(maxTravel, groundHeight - bodyHeight));
}
