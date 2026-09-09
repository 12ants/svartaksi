/**
 * The dog companion: a pure, WebGL-free behavior model for backlog item 16's
 * stalking-to-partner arc. Built on the same pattern as horseBody.ts — plain
 * data state, a stepX(state, input, dt, ...injected queries) function, ground
 * height read back from an injected terrainHeightAt rather than imported —
 * so this module has no dependency on three.js or any GPU context.
 *
 * The stalking state's "prefer cover, not a fixed-radius orbit" requirement
 * needs an occlusion query this module cannot provide itself; isVisible is
 * injected the same way terrainHeightAt is, so a fake in tests today can
 * become real building/vegetation data later without changing this file's
 * shape.
 */

import type { LocalPoint } from '../world/types';

/**
 * Where the dog is first placed, relative to START_LOCATION (which is local-origin
 * (0, 0) — see config.ts). 35m east, 10m south: close enough to be within sight of a
 * player who has just started at the wheel. This point does not need to be
 * tile-verified the way START_LOCATION/CAMP_LOCATION were — svartaksiRuntime.tsx only
 * ever uses it as the *authored* input to bonfireCamp.ts's resolveCampPoint, whose
 * widening safety search resolves it to a real safe point at runtime regardless of how
 * close the guess is.
 */
export const DOG_SPAWN_LOCAL: LocalPoint = { x: 35, z: 10 };

export type DogBehaviorState = 'stalking' | 'wary' | 'following' | 'companion';

export interface DogState {
  behavior: DogBehaviorState;
  trust: number;
  x: number;
  z: number;
  y: number;
  heading: number;
}

export interface DogStepInput {
  playerPosition: { x: number; z: number };
  /** m/s; distinguishes a calm approach from a chase. */
  playerSpeed: number;
  /** True if the player's forward heading points roughly at the dog. */
  playerFacingDog: boolean;
}

/** How far the dog moves per second while actively retreating. */
const STALKING_RETREAT_SPEED_MPS = 3.5;

/** Candidate retreat headings sampled every 45 degrees around the dog. */
const STALKING_CANDIDATE_HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315].map(
  (deg) => (deg * Math.PI) / 180,
);

/** Added to a candidate's distance-gained score when it is not visible to the player. */
const COVER_BONUS_METERS = 3;

/** How far the dog moves per second while following the player. */
const FOLLOWING_SPEED_MPS = 4.0;

/** The dog stops moving when within this distance of the player while following. */
const FOLLOW_RADIUS_METERS = 2.0;

/** Player must be within this range of the dog for trust to change at all. */
const AWARENESS_RANGE_METERS = 12;

/** m/s below which the player counts as "still" for trust purposes. */
const STILLNESS_SPEED_MPS = 0.5;

/** Trust points gained per second under calm conditions, by current behavior. */
const TRUST_GAIN_PER_SECOND: Record<DogBehaviorState, number> = {
  stalking: 2,
  wary: 3,
  following: 5,
  companion: 5,
};

/** Trust points lost per second under a fast, direct approach while not yet a companion. */
const TRUST_LOSS_PER_SECOND = 8;

/** Trust thresholds a behavior must reach to advance to the next state. */
const TRUST_THRESHOLDS: Record<Exclude<DogBehaviorState, 'companion'>, number> = {
  stalking: 20,
  wary: 50,
  following: 80,
};

const BEHAVIOR_ORDER: DogBehaviorState[] = ['stalking', 'wary', 'following', 'companion'];

export function createDogState(x: number, z: number, heading = 0): DogState {
  return { behavior: 'stalking', trust: 0, x, z, y: 0, heading };
}

function headingTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function distanceBetween(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pointAtHeading(
  origin: { x: number; z: number },
  heading: number,
  distance: number,
): { x: number; z: number } {
  return { x: origin.x + Math.sin(heading) * distance, z: origin.z + Math.cos(heading) * distance };
}

function nextBehavior(behavior: DogBehaviorState): DogBehaviorState {
  const index = BEHAVIOR_ORDER.indexOf(behavior);
  return BEHAVIOR_ORDER[Math.min(index + 1, BEHAVIOR_ORDER.length - 1)];
}

function updateTrust(state: DogState, input: DogStepInput, dt: number): number {
  const distance = distanceBetween(state, input.playerPosition);
  if (distance > AWARENESS_RANGE_METERS) return state.trust;

  const calm = input.playerSpeed <= STILLNESS_SPEED_MPS || !input.playerFacingDog;
  let delta = calm
    ? TRUST_GAIN_PER_SECOND[state.behavior] * dt
    : -TRUST_LOSS_PER_SECOND * dt;

  // Once following or companion, trust is monotonic non-decreasing: it can only stay the same or rise, never fall
  if (state.behavior === 'following' || state.behavior === 'companion') {
    delta = Math.max(0, delta);
  }

  return Math.max(0, Math.min(100, state.trust + delta));
}

function nextBehaviorFor(behavior: DogBehaviorState, trust: number): DogBehaviorState {
  if (behavior === 'companion') return behavior;
  const threshold = TRUST_THRESHOLDS[behavior];
  return trust >= threshold ? nextBehavior(behavior) : behavior;
}

/**
 * Scores each of the fixed candidate headings by distance gained from the
 * player plus a cover bonus when isVisible reports false, and returns the
 * best-scoring candidate point. Replaces any notion of a fixed-radius orbit:
 * the dog moves toward whichever sampled point is both far and hidden, not
 * toward a point at a constant distance from the player.
 */
function bestStalkingRetreatPoint(
  state: DogState,
  input: DogStepInput,
  distance: number,
  isVisible: (point: { x: number; z: number }) => boolean,
): { x: number; z: number } {
  let best = { x: state.x, z: state.z };
  let bestScore = -Infinity;
  for (const heading of STALKING_CANDIDATE_HEADINGS) {
    const candidate = pointAtHeading(state, heading, distance);
    const distanceGained = distanceBetween(candidate, input.playerPosition) - distanceBetween(state, input.playerPosition);
    const score = distanceGained + (isVisible(candidate) ? 0 : COVER_BONUS_METERS);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function stepStalking(
  state: DogState,
  input: DogStepInput,
  dt: number,
  isVisible: (point: { x: number; z: number }) => boolean,
): { x: number; z: number; heading: number } {
  const travel = STALKING_RETREAT_SPEED_MPS * dt;
  const target = bestStalkingRetreatPoint(state, input, travel, isVisible);
  return { x: target.x, z: target.z, heading: headingTo(state, target) };
}

function stepWary(state: DogState, input: DogStepInput, dt: number): { x: number; z: number; heading: number } {
  const distance = distanceBetween(state, input.playerPosition);
  const approachingFast = input.playerSpeed > STILLNESS_SPEED_MPS && input.playerFacingDog;
  if (!approachingFast || distance > AWARENESS_RANGE_METERS) {
    return { x: state.x, z: state.z, heading: state.heading };
  }
  const away = headingTo(input.playerPosition, state);
  const target = pointAtHeading(state, away, STALKING_RETREAT_SPEED_MPS * 0.5 * dt);
  return { x: target.x, z: target.z, heading: away };
}

function stepFollowing(state: DogState, input: DogStepInput, dt: number): { x: number; z: number; heading: number } {
  const distance = distanceBetween(state, input.playerPosition);
  if (distance <= FOLLOW_RADIUS_METERS) {
    return { x: state.x, z: state.z, heading: state.heading };
  }
  const toward = headingTo(state, input.playerPosition);
  const travel = Math.min(FOLLOWING_SPEED_MPS * dt, distance - FOLLOW_RADIUS_METERS);
  const target = pointAtHeading(state, toward, travel);
  return { x: target.x, z: target.z, heading: toward };
}

export function stepDog(
  state: DogState,
  input: DogStepInput,
  dt: number,
  terrainHeightAt: (point: { x: number; z: number }) => number,
  isVisible: (point: { x: number; z: number }) => boolean,
): DogState {
  const trust = updateTrust(state, input, dt);
  const behavior = nextBehaviorFor(state.behavior, trust);

  const moved =
    behavior === 'stalking'
      ? stepStalking(state, input, dt, isVisible)
      : behavior === 'wary'
        ? stepWary(state, input, dt)
        : stepFollowing(state, input, dt);

  const y = terrainHeightAt({ x: moved.x, z: moved.z });
  return { behavior, trust, x: moved.x, z: moved.z, y, heading: moved.heading };
}
