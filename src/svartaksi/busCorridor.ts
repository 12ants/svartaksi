/**
 * Fetches the road data a bus route needs and turns it into a path.
 *
 * The normal world stream only loads roads around the camera, but a bus's start and
 * destination can be picked anywhere on the overmap — and the opening ride spans six
 * kilometres — so this issues its own one-off provider call covering both picks,
 * independent of the camera-follow streaming radius, and never touches the streamed
 * world.
 *
 * It asks for a *corridor* (see WorldDataCorridor): the ribbon along the route rather
 * than a disc around its midpoint. The radius is kept as a fallback for providers that
 * cannot express one.
 */
import {
  buildRoadGraph,
  buildRideProfile,
  estimateRideDuration,
  findRoute,
  pathLength,
  sampleRide,
  simplifyPath,
} from './busRouting';
import { START_LOCATION } from './config';
import { findRouteSignalStops, findTrafficSignals, type RouteSignalStop } from './trafficLights';
import { lngLatToLocal } from '../world/geo';
import { createMapLibreProvider } from '../world/providers/maplibreProvider';
import type { LngLat, LocalPoint, WorldDataProvider } from '../world/types';

export type BusRouteResult =
  | { ok: true; path: LocalPoint[]; lengthMeters: number; etaSeconds: number; signalStops: RouteSignalStop[] }
  | { ok: false; reason: 'fetch-failed' | 'no-route' };

/** Generous cap on how many signal heads are worth finding across a whole route — well
 * above anything a single ride crosses, unlike the render-side cap in threeWorld.ts,
 * which is deliberately tight because it bounds GPU instances, not route lookups. */
const ROUTE_SIGNAL_LIMIT = 400;

/** Extra meters fetched beyond the two picks, so a route that has to detour
 * sideways off the direct line still has road data to detour onto. */
const CORRIDOR_PADDING = 700;

/** Buildings are irrelevant to routing — ask for the smallest radius the provider
 * accepts rather than paying for facade-grade building data we throw away. */
const CORRIDOR_BUILDING_RADIUS = 1;

export async function resolveBusRoute(
  start: LngLat,
  destination: LngLat,
  signal: AbortSignal,
  provider: WorldDataProvider = createMapLibreProvider(),
): Promise<BusRouteResult> {
  const startLocal = lngLatToLocal(START_LOCATION, start);
  const destLocal = lngLatToLocal(START_LOCATION, destination);
  const center: LngLat = { lng: (start.lng + destination.lng) / 2, lat: (start.lat + destination.lat) / 2 };
  const halfSpan = Math.hypot(destLocal.x - startLocal.x, destLocal.z - startLocal.z) / 2;

  let roads;
  try {
    const data = await provider.load(
      center,
      { buildings: CORRIDOR_BUILDING_RADIUS, terrain: halfSpan + CORRIDOR_PADDING },
      signal,
      START_LOCATION,
      // Providers that understand a corridor fetch only the ribbon along the route; the
      // radius above stays as the fallback for those that don't. Both describe the same
      // area, so a provider honouring either one returns a routable corridor.
      { from: start, to: destination, padMeters: CORRIDOR_PADDING },
    );
    roads = data.roads;
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }

  const found = findRoute(buildRoadGraph(roads), startLocal, destLocal);
  if (!found) return { ok: false, reason: 'no-route' };

  // Strip the graph's quantization jitter before anything measures the route. Without
  // this the ride profile reads a straight road as a chain of tight corners and the bus
  // crawls the whole way; see PATH_SIMPLIFY_TOLERANCE.
  const path = simplifyPath(found);
  const lengthMeters = pathLength(path);
  // Found from the same corridor fetch the route itself used, not the render's own
  // draw-distance-limited search (threeWorld.ts) — a ride crosses ground well beyond
  // what's ever on screen at once, and the two must agree on where a route actually
  // stops regardless of what happens to be rendered at the time.
  const signalStops = findRouteSignalStops(path, findTrafficSignals(roads, ROUTE_SIGNAL_LIMIT));
  // ETA comes from the same accelerate/brake integration the ride itself runs, not
  // from length / cruise speed, so a corner-heavy route quotes honestly.
  return {
    ok: true,
    path,
    lengthMeters,
    etaSeconds: estimateRideDuration(buildRideProfile(path)),
    signalStops,
  };
}

export interface RideCorridorLeg {
  from: LocalPoint;
  to: LocalPoint;
}

/**
 * The next stretch of an already-known route worth streaming ahead of the bus, or null
 * if the last fetch is still comfortably ahead of it.
 *
 * Once a route is resolved its whole path is already in memory (see resolveBusRoute) —
 * unlike the free-roam camera stream, which only ever predicts a point ahead, this can
 * fetch the ribbon the bus is actually going to cross next, a leg at a time, rather than
 * a disc around wherever the camera happens to be pointed. `lastFetchedAtMeters` is the
 * traveled distance the previous leg was anchored to (or `-Infinity` before any fetch),
 * so due-ness is measured by progress since that fetch, not distance from the route's
 * start.
 */
export function nextRideCorridorLeg(
  path: LocalPoint[],
  traveledMeters: number,
  lastFetchedAtMeters: number,
  restreamMeters: number,
  lookaheadMeters: number,
): RideCorridorLeg | null {
  if (traveledMeters - lastFetchedAtMeters < restreamMeters) return null;
  return {
    from: sampleRide(path, traveledMeters).point,
    to: sampleRide(path, traveledMeters + lookaheadMeters).point,
  };
}
