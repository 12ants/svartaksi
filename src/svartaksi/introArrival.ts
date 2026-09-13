/**
 * Planning the short ride the cinematic hands over to.
 *
 * When the intro ends, the player is aboard a moving bus and the world underneath has just
 * been swapped for the real one (see the handoff in svartaksiRuntime.tsx). The bus needs
 * somewhere to be going, and the answer the opening was designed around is: not far. It
 * pulls in near the parked taxi, the player steps off beside it, and ordinary play begins
 * exactly where it begins today.
 *
 * Deliberately *not* a route search. `busCorridor.ts` exists for a real cross-town journey
 * — it fetches its own corridor and runs A* over a road graph — and leaning on it here is
 * what sank the previous scripted opening: a network round trip and a long-distance
 * pathfind, both able to fail, standing between the player and their first frame. This
 * instead picks a carriageway out of the world data that is *already loaded and drawn*,
 * and walks back along it. It cannot fail for want of network, and the road it chooses is
 * visibly there.
 */
import { isBusDrivableKind } from './roadStyle';
import type { LocalPoint, WorldRoad } from '../world/types';

/**
 * How long the arrival ride should be, in metres.
 *
 * Long enough that the player has a moment to register they are on a bus in a city rather
 * than in the woods — the cut is hidden, so this is where the change of place actually
 * lands — and short enough that it is an arrival rather than a second journey. At the
 * bus's 12.5 m/s this is about twenty seconds.
 */
export const ARRIVAL_RIDE_METERS = 250;

interface Landing {
  road: WorldRoad;
  /** Index of the vertex the ride should finish at. */
  index: number;
  /** How far that vertex is from the target, in metres. */
  distance: number;
}

/** The bus-drivable vertex, across every loaded road, that comes closest to `target`. */
function findLanding(roads: readonly WorldRoad[], target: LocalPoint): Landing | null {
  let best: Landing | null = null;
  for (const road of roads) {
    if (!isBusDrivableKind(road.kind)) continue;
    if (road.points.length < 2) continue;
    for (let index = 0; index < road.points.length; index += 1) {
      const distance = Math.hypot(road.points[index].x - target.x, road.points[index].z - target.z);
      if (!best || distance < best.distance) best = { road, index, distance };
    }
  }
  return best;
}

export interface ArrivalRide {
  /** The path to hand to `applyStartBusRide`, ending at the stop. */
  path: LocalPoint[];
  /** How far the last point ends up from the target, in metres — the distance the player
   * will have to walk to the car. Surfaced rather than swallowed so a caller can log it. */
  stopDistance: number;
}

/**
 * Builds a ride of roughly `meters` that finishes as close to `target` as the loaded road
 * network allows.
 *
 * Walks *backwards* from the landing vertex along its own road, which is what makes this
 * robust: it never leaves the one carriageway, so it cannot produce a path with a
 * discontinuity in it, and it needs no graph, no junction snapping and no search. The cost
 * is that the ride's shape is whatever that road happens to do — which is fine, because it
 * is a real street and the bus is driving down it in the usual way.
 *
 * Returns null when nothing drivable is loaded, or when the chosen road is too short to be
 * worth a ride. The caller's fallback is to skip the arrival ride and simply set the
 * player down, which is a worse opening but never a broken one.
 */
export function planArrivalRide(
  roads: readonly WorldRoad[],
  target: LocalPoint,
  meters: number = ARRIVAL_RIDE_METERS,
): ArrivalRide | null {
  const landing = findLanding(roads, target);
  if (!landing) return null;

  const points = landing.road.points;
  // Both directions are legitimate approaches to the same stop; take whichever gives more
  // road to run before it, so a landing near one end of a street still yields a ride.
  const forwardRoom = landing.index;
  const backwardRoom = points.length - 1 - landing.index;
  const towardHigherIndex = backwardRoom > forwardRoom;

  const path: LocalPoint[] = [];
  let traveled = 0;
  let index = landing.index;
  while (traveled < meters) {
    const next = towardHigherIndex ? index + 1 : index - 1;
    if (next < 0 || next >= points.length) break;
    traveled += Math.hypot(points[next].x - points[index].x, points[next].z - points[index].z);
    index = next;
    path.push(points[index]);
  }
  // Collected walking away from the stop, so reverse it: the bus drives toward the target,
  // and `applyStartBusRide` reads a path as start-to-finish.
  path.reverse();
  path.push(points[landing.index]);

  // Two points is a path in name only, and `buildRideProfile` pins both ends to a
  // standstill — a ride that short is a lurch, not an arrival.
  if (path.length < 3 || traveled < 40) return null;
  return { path, stopDistance: landing.distance };
}
