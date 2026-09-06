/**
 * The horse: a third controllable body alongside the car and the on-foot player, built
 * as a genuinely separate control mode rather than a second `carryDrivenBody`.
 *
 * `carryDrivenBody` (see svartaksiRuntime.tsx) exists for bodies whose *pose is computed
 * elsewhere* — a route, a walk controller — and only overwrites a physics body's pose so
 * props feel its momentum; it is explicitly flagged in docs/TODO.md as a kinematic-body
 * workaround against engine internals. The horse is the opposite shape of problem: its
 * pose *is* the state driven directly by player input (gait selection + turn), stepped
 * forward here in plain math, with the ground read back from `terrainHeightAt` every
 * step so it neither hovers above nor sinks into sloped terrain. Nothing here touches a
 * `RigidBody` or the physics broadphase — mounting is a mode transition (see the car's
 * enter/exit-vehicle proximity check in svartaksiRuntime.tsx, `PlayerMode`), not a physics
 * takeover, matching the pattern the car and bus already use for whose input drives what.
 *
 * Pure and WebGL-free by construction: `terrainHeightAt` is injected, so this module has
 * no dependency on three.js's renderer or any GPU context and is fully unit-testable.
 */

import { HORSE } from './gameplayConfig';

export type HorseGait = 'stand' | 'walk' | 'trot' | 'canter';
export type HorseMode = 'idle' | 'mounted';

/** Metres per second at each gait. Speed comes from which gait the rider has chosen, not
 * from a throttle blended against a top speed the way the car works — a horse does not
 * have intermediate speeds within a gait the way an engine has intermediate RPM. */
export const GAIT_SPEED_MPS: Record<HorseGait, number> = HORSE.gaitSpeedMps;

/** How fast heading turns at speed, radians/second — a horse steers by leaning and does
 * not pivot in place, so turn rate is deliberately modest next to the car's. */
const TURN_RATE_RAD_PER_S = HORSE.turnRateRadPerS;

/** How close the player must be to mount, in metres — the same order of magnitude as the
 * car's enter-prompt proximity in svartaksiRuntime.tsx. */
export const MOUNT_RANGE_METERS = HORSE.mountRangeMeters;

export interface HorseState {
  mode: HorseMode;
  gait: HorseGait;
  x: number;
  z: number;
  y: number;
  heading: number;
}

export interface HorseInput {
  /** The rider's chosen gait. Only meaningful while mounted. */
  gait: HorseGait;
  /** -1..1, steering input; positive turns right. */
  turn: number;
}

export function createHorseState(x: number, z: number, heading = 0): HorseState {
  return { mode: 'idle', gait: 'stand', x, z, y: 0, heading };
}

function distanceTo(state: HorseState, point: { x: number; z: number }): number {
  return Math.hypot(state.x - point.x, state.z - point.z);
}

/** Whether a rider standing at `riderPoint` is close enough to mount this horse. */
export function canMount(state: HorseState, riderPoint: { x: number; z: number }): boolean {
  return state.mode === 'idle' && distanceTo(state, riderPoint) <= MOUNT_RANGE_METERS;
}

/** Mounts the horse if the rider is in range; otherwise returns the horse unchanged —
 * mirrors the car's enter-vehicle path, which likewise no-ops outside its proximity
 * check rather than teleporting the player to the vehicle. */
export function mount(state: HorseState, riderPoint: { x: number; z: number }): HorseState {
  if (!canMount(state, riderPoint)) return state;
  return { ...state, mode: 'mounted', gait: 'stand' };
}

/** Dismounts, leaving the horse standing exactly where the ride ended. */
export function dismount(state: HorseState): HorseState {
  if (state.mode === 'idle') return state;
  return { ...state, mode: 'idle', gait: 'stand' };
}

/**
 * Advances the horse by `dt` seconds. A no-op while unmounted (nothing rides an idle
 * horse). Movement is gait speed along the current heading, heading integrates turn
 * input, and height is re-sampled from `terrainHeightAt` after moving — the same
 * terrain-following contract `terrainHeightAt` gives the car and the on-foot player, so
 * the horse neither floats above a slope nor is buried by one.
 */
/**
 * How deep the horse will wade before it refuses, in metres — chest-deep on a horse, and
 * comfortably past anything the shallows of a shelving shore actually hold.
 *
 * The horse refuses rather than swims. It could be made to swim — the pill and the blob
 * both do — but that is a whole second movement state for a body with a four-gait
 * animation rig and nothing to drive a swimming one with, and a rider who cannot tell
 * whether the horse is about to swim or stop is worse off than one who knows the water's
 * edge is the edge. So deep water is a wall you can turn away from.
 */
export const HORSE_MAX_WADE_DEPTH = 1;

export function stepHorse(
  state: HorseState,
  input: HorseInput,
  dt: number,
  terrainHeightAt: (point: { x: number; z: number }) => number,
  canStandAt: (point: { x: number; z: number }) => boolean = () => true,
): HorseState {
  if (state.mode !== 'mounted') return state;

  const heading = state.heading + input.turn * TURN_RATE_RAD_PER_S * dt;
  const speed = GAIT_SPEED_MPS[input.gait];
  // forward = (sin(heading), 0, cos(heading)) — same convention svartaksiRuntime's bus/car
  // heading math uses (see BUS_HEADING_TAU callers), so a horse and a car agree on what
  // heading 0 faces.
  const wantedX = state.x + Math.sin(heading) * speed * dt;
  const wantedZ = state.z + Math.cos(heading) * speed * dt;
  // Refused ground stops the step but never the turn: a horse held against the water's
  // edge must still be able to turn away from it, and freezing the heading too would
  // leave the rider stuck facing the sea with no way out.
  const blocked = !canStandAt({ x: wantedX, z: wantedZ });
  const x = blocked ? state.x : wantedX;
  const z = blocked ? state.z : wantedZ;
  const y = terrainHeightAt({ x, z });

  return { mode: 'mounted', gait: input.gait, x, z, y, heading };
}
