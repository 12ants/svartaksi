/**
 * Getting into and out of a vehicle as a movement, not a teleport.
 *
 * Ported from Sketchbook's vehicle character states (`OpenVehicleDoor`,
 * `EnteringVehicle`, `ExitingVehicle`, `CloseVehicleDoorOutside`), which are the reason
 * that project's car feels inhabited: the character walks to the door, swings it open,
 * lowers itself into the seat and pulls the door shut, and reverses all of it to get out.
 * The game this was grafted onto previously switched bodies in a single frame — the pill
 * vanished and the car started moving — and no amount of camera work hides that.
 *
 * Two things make the port more than a tween:
 *
 * - **Everything is in vehicle-local space.** The character is carried by the car for the
 *   whole sequence, so a car rolling down a hill (or a bus pulling away) takes the
 *   half-seated player with it rather than stretching them across the world. This is what
 *   Sketchbook gets by re-parenting the character to the vehicle for the duration; here
 *   the caller converts to world space once per frame with the vehicle's current pose.
 * - **The transition can be abandoned.** Ask for a direction while the door is still
 *   opening and the character steps away instead, exactly as in the source. An entry you
 *   cannot change your mind about is a cutscene.
 *
 * This module is pure: it owns timings, easing and the pose at time t, and knows nothing
 * about scene graphs, input devices or physics bodies. `svartaksiRuntime.tsx` binds it.
 */
import * as THREE from 'three';
import { createSpringSimulator, easeInOutSine, type SpringSimulator } from './springSimulator';
import { VEHICLE_ACCESS } from './gameplayConfig';

/**
 * Where a body gets in, in the vehicle's own coordinates.
 *
 * `entry` is the spot on the road beside the open door where the character stands to
 * begin — Sketchbook's `entryPoint` — and `seat` is where they end up. The vector between
 * them is also what decides which way the door swings and which shoulder leads.
 */
export interface VehicleAccessPoint {
  /** Standing position beside the door, vehicle-local, feet on the ground. */
  entry: THREE.Vector3;
  /** Seated position, vehicle-local. */
  seat: THREE.Vector3;
  /** Yaw the body faces once seated, vehicle-local radians. Forward is +Z, as elsewhere. */
  seatYaw: number;
  /** Which side of the vehicle this door is on: -1 for the driver's left, +1 right. */
  side: -1 | 1;
}

/**
 * Which side of the seat the door is on, from the two points alone.
 *
 * Sketchbook computes this from the entry point's own right vector; in vehicle-local
 * space, where the body always faces +Z, it collapses to the sign of the x offset — the
 * same answer with none of the matrix work, and one that a test can state in a line.
 */
export function accessSide(entry: THREE.Vector3, seat: THREE.Vector3): -1 | 1 {
  return entry.x - seat.x >= 0 ? 1 : -1;
}

export type VehicleTransitionPhase =
  /** Walking the last step to the door and swinging it open. */
  | 'opening'
  /** Lowering into the seat; the door stands open behind. */
  | 'entering'
  /** Rising out of the seat and back onto the road. */
  | 'exiting'
  /** Standing beside the vehicle, pushing the door shut. */
  | 'closing'
  /** The body is in the seat; the caller should hand control to the vehicle. */
  | 'seated'
  /** The body is back on its feet; the caller should hand control back to it. */
  | 'afoot';

/** What the caller does with the machine's answer each frame. */
export interface VehicleTransitionPose {
  /** Vehicle-local position of the body's feet. */
  position: THREE.Vector3;
  /** Vehicle-local yaw of the body. */
  yaw: number;
  /** 0 shut, 1 fully open — drive the door leaf and any boarding gate off this. */
  doorOpen: number;
  phase: VehicleTransitionPhase;
  /** True on the frame the sequence reaches `seated` or `afoot`, and every frame after. */
  finished: boolean;
}

export interface VehicleTransition {
  phase: VehicleTransitionPhase;
  access: VehicleAccessPoint;
  /** Seconds spent in the current phase. */
  elapsed: number;
  /** Where this phase started from, vehicle-local. */
  from: THREE.Vector3;
  fromYaw: number;
  to: THREE.Vector3;
  toYaw: number;
  doorOpen: number;
  /** Set when the body left the seat while the vehicle was still moving — the caller
   * turns this into a stumble rather than a tidy landing, as Sketchbook's `DropRolling`
   * does. Read once, on completion. */
  stumbled: boolean;
  spring: SpringSimulator;
}

function phaseDuration(phase: VehicleTransitionPhase): number {
  switch (phase) {
    case 'opening': return VEHICLE_ACCESS.openDoorSeconds;
    case 'entering': return VEHICLE_ACCESS.sitDownSeconds;
    case 'exiting': return VEHICLE_ACCESS.standUpSeconds;
    case 'closing': return VEHICLE_ACCESS.closeDoorSeconds;
    default: return 0;
  }
}

function beginPhase(
  transition: VehicleTransition,
  phase: VehicleTransitionPhase,
  from: THREE.Vector3,
  fromYaw: number,
  to: THREE.Vector3,
  toYaw: number,
): void {
  transition.phase = phase;
  transition.elapsed = 0;
  transition.from.copy(from);
  transition.fromYaw = fromYaw;
  transition.to.copy(to);
  transition.toYaw = toYaw;
  transition.spring = createSpringSimulator(
    VEHICLE_ACCESS.springFps,
    VEHICLE_ACCESS.springMass,
    VEHICLE_ACCESS.springDamping,
  );
  transition.spring.target = 1;
}

/**
 * Starts the get-in sequence from wherever the body is standing.
 *
 * `bodyPosition`/`bodyYaw` are vehicle-local. The first phase carries the body the last
 * step to the door — Sketchbook's open-door animation moves the character onto the entry
 * point rather than requiring the player to have hit it exactly, which is what lets the
 * approach be forgiving without the arrival being sloppy.
 */
export function beginVehicleEntry(
  access: VehicleAccessPoint,
  bodyPosition: THREE.Vector3,
  bodyYaw: number,
): VehicleTransition {
  const transition: VehicleTransition = {
    phase: 'opening',
    access,
    elapsed: 0,
    from: new THREE.Vector3(),
    fromYaw: 0,
    to: new THREE.Vector3(),
    toYaw: 0,
    doorOpen: 0,
    stumbled: false,
    spring: createSpringSimulator(),
  };
  // Facing the door on the way in, not the seat: the body turns its back on the car only
  // once it is at the door, which is the difference between walking up to a car and
  // sidling into it.
  beginPhase(transition, 'opening', bodyPosition, bodyYaw, access.entry, yawTowards(bodyPosition, access.entry, bodyYaw));
  return transition;
}

/**
 * Starts the get-out sequence from the seat.
 *
 * `vehicleSpeed` is the vehicle's ground speed in m/s at the moment the player asked to
 * leave. Above `stumbleSpeed` the landing is recorded as a stumble; the caller decides
 * what that costs. Sketchbook drops the character into a roll here — the point either way
 * is that stepping out of a moving car is not free.
 */
export function beginVehicleExit(
  access: VehicleAccessPoint,
  vehicleSpeed: number,
): VehicleTransition {
  const transition: VehicleTransition = {
    phase: 'exiting',
    access,
    elapsed: 0,
    from: new THREE.Vector3(),
    fromYaw: 0,
    to: new THREE.Vector3(),
    toYaw: 0,
    // The door is already open by the time anyone is climbing out of it.
    doorOpen: 1,
    stumbled: Math.abs(vehicleSpeed) > VEHICLE_ACCESS.stumbleSpeed,
    spring: createSpringSimulator(),
  };
  beginPhase(
    transition,
    'exiting',
    access.seat,
    access.seatYaw,
    access.entry,
    // Facing out of the car, away from the seat: you get out looking where you are going.
    yawTowards(access.seat, access.entry, access.seatYaw),
  );
  return transition;
}

/** Yaw that points from `from` to `to`; keeps `fallback` when the two coincide. */
export function yawTowards(from: THREE.Vector3, to: THREE.Vector3, fallback: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return fallback;
  return Math.atan2(dx, dz);
}

/** Shortest signed angle from `a` to `b`, so a turn never takes the long way round. */
export function shortestAngle(a: number, b: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export interface VehicleTransitionInput {
  /** True while the player is asking to move. During `opening` this abandons the entry,
   * matching Sketchbook's `anyDirection()` check. Ignored in every other phase: once you
   * are folding yourself into a seat it is too late to walk away. */
  wantsToMove: boolean;
}

/**
 * Advances the sequence and reports where the body is now.
 *
 * Mutates `transition` (it is a per-attempt object owned by the caller) and returns the
 * pose for this frame. When the returned phase is `seated` or `afoot` the sequence is
 * over and the caller should hand control on; calling again after that is a no-op that
 * keeps reporting the final pose.
 */
export function advanceVehicleTransition(
  transition: VehicleTransition,
  dt: number,
  input: VehicleTransitionInput = { wantsToMove: false },
): VehicleTransitionPose {
  if (transition.phase === 'seated' || transition.phase === 'afoot') {
    return {
      position: transition.to.clone(),
      yaw: transition.toYaw,
      doorOpen: transition.doorOpen,
      phase: transition.phase,
      finished: true,
    };
  }

  transition.elapsed += dt;
  transition.spring.simulate(dt);

  const duration = phaseDuration(transition.phase);
  const linear = duration <= 0 ? 1 : Math.min(1, transition.elapsed / duration);

  // Two factors, as in the source: the spring drives the turn (and the last of the
  // approach), the eased clock drives the travel. Using the spring for both would leave
  // the body short of the seat when the phase ends, since a spring only asymptotes.
  const travel = easeInOutSine(linear);
  const turn = Math.min(1, transition.spring.position);

  const position = new THREE.Vector3().lerpVectors(transition.from, transition.to, travel);
  const yaw = transition.fromYaw + shortestAngle(transition.fromYaw, transition.toYaw) * turn;

  transition.doorOpen = doorOpenFor(transition, linear);

  if (linear >= 1) {
    advancePhase(transition, input);
  }

  const phase = currentPhase(transition);
  return {
    position,
    yaw,
    doorOpen: transition.doorOpen,
    phase,
    finished: phase === 'seated' || phase === 'afoot',
  };
}

/**
 * How far the door is open during a phase.
 *
 * The door starts moving a beat into the approach rather than at its start — Sketchbook
 * waits 0.3s of the open-door animation, which is the reach — and it is fully open before
 * the body starts to sit, so nobody climbs through a half-open leaf. Closing runs the
 * whole length of its own phase, because pulling a door shut *is* that phase.
 */
export function doorOpenFor(transition: VehicleTransition, linear: number): number {
  const { openDoorSeconds, doorReachSeconds } = VEHICLE_ACCESS;
  switch (transition.phase) {
    case 'opening': {
      const swing = Math.max(1e-6, openDoorSeconds - doorReachSeconds);
      return THREE.MathUtils.clamp((transition.elapsed - doorReachSeconds) / swing, 0, 1);
    }
    case 'entering':
    case 'exiting':
      return 1;
    case 'closing':
      return 1 - linear;
    default:
      return transition.doorOpen;
  }
}

/** Reads the phase back without the narrowing the guard at the top of `advance` leaves
 * behind: `advancePhase` mutates it, and TypeScript has no way to know that. */
function currentPhase(transition: VehicleTransition): VehicleTransitionPhase {
  return transition.phase;
}

function advancePhase(transition: VehicleTransition, input: VehicleTransitionInput): void {
  const { access } = transition;
  switch (transition.phase) {
    case 'opening': {
      if (input.wantsToMove) {
        // Changed their mind at the door. Left standing on the entry point, door open —
        // the honest state, and one the next press can pick straight back up from.
        transition.phase = 'afoot';
        return;
      }
      beginPhase(transition, 'entering', access.entry, transition.toYaw, access.seat, access.seatYaw);
      return;
    }
    case 'entering':
      transition.phase = 'seated';
      transition.to.copy(access.seat);
      transition.toYaw = access.seatYaw;
      // Doors are pulled shut from the inside the moment you are in the seat, which is
      // Sketchbook's `CloseVehicleDoorInside` compressed to its outcome: there is nothing
      // to watch, and a car that drives off with its door hanging open is a bug report.
      transition.doorOpen = 0;
      return;
    case 'exiting':
      beginPhase(transition, 'closing', access.entry, transition.toYaw, access.entry, transition.toYaw);
      return;
    case 'closing':
      transition.phase = 'afoot';
      transition.doorOpen = 0;
      return;
    default:
  }
}

/**
 * The driver's door of a car whose seat sits at `seat`, given its half-width.
 *
 * Kept here rather than in the car model because it is the same arithmetic for anything
 * with a door in its side: stand the entry point a step outboard of the sill, level with
 * the seat, on the seat's own side of the car.
 */
export function sideAccessPoint(
  seat: THREE.Vector3,
  halfWidth: number,
  side: -1 | 1 = -1,
): VehicleAccessPoint {
  return {
    entry: new THREE.Vector3(
      side * (halfWidth + VEHICLE_ACCESS.doorStandOffset),
      0,
      seat.z,
    ),
    seat: seat.clone(),
    seatYaw: 0,
    side,
  };
}
