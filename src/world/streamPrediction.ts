import type { LocalPoint } from './types';

const MIN_LOOK_AHEAD_METERS = 180;
const MAX_LOOK_AHEAD_METERS = 520;

export function predictStreamCenter(
  position: LocalPoint,
  heading: number,
  lookAheadMeters = 360,
): LocalPoint {
  if (![position.x, position.z, heading, lookAheadMeters].every(Number.isFinite)) {
    return { ...position };
  }
  const distance = Math.min(
    MAX_LOOK_AHEAD_METERS,
    Math.max(MIN_LOOK_AHEAD_METERS, lookAheadMeters),
  );
  return {
    x: clean(position.x + Math.sin(heading) * distance),
    z: clean(position.z + Math.cos(heading) * distance),
  };
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Whether the world should be re-streamed around a new centre.
 *
 * The trigger this replaced compared *this* frame's look-ahead point against the look-ahead
 * point of the last stream. Both swing with the player's heading, so the comparison
 * measured turning as well as travelling: with a 420m look-ahead and a 520m threshold, a
 * 90-degree turn moved the compared point by 594m and a U-turn by 840m, so a car taking two
 * corners re-streamed the world without going anywhere. Switching between the chase and
 * top-down cameras did it too, because they use different look-ahead distances — 300m of
 * apparent movement from a keypress. That is the shape of the "world rebuilds every five
 * seconds during play" report: it was rebuilding on corners.
 *
 * The rule here measures the two things that actually determine whether the loaded data is
 * still any good:
 *
 * - **How far the player has travelled** since the last stream was requested. This is what
 *   the old threshold was meant to be, and for a car driving in a straight line it fires at
 *   exactly the same distance it used to.
 * - **Whether the ground being driven towards is still inside what was loaded.** Turning
 *   does not move the player, but it can point them at a part of the map the last load did
 *   not reach. Compared against the *loaded centre* — a fixed point until the next load —
 *   rather than against a previous look-ahead, so it answers "is this covered?" instead of
 *   "has the camera swung?".
 */
export function shouldRestream(
  player: LocalPoint,
  lookAhead: LocalPoint,
  lastStreamedFrom: LocalPoint,
  loadedCenter: LocalPoint,
  options: { travelDistance: number; coverageRadius: number },
): boolean {
  if (![player.x, player.z, lookAhead.x, lookAhead.z].every(Number.isFinite)) return false;
  if (distance(player, lastStreamedFrom) > options.travelDistance) return true;
  return distance(lookAhead, loadedCenter) > options.coverageRadius;
}

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
