/**
 * Pure routing over the world's road polylines: turns the independent per-road
 * lines in WorldData into one connected graph, routes between two points on it
 * with ngraph.path, and samples progress along the resulting path.
 * Framework-agnostic (no THREE, no React, no DOM) in the same spirit as
 * roadStyle.ts, so it can be unit-tested without a WebGL context.
 */
import createGraph, { type Graph } from 'ngraph.graph';
import { nba } from 'ngraph.path';

import type { LocalPoint, WorldRoad } from '../world/types';
import { BUS_DIMENSIONS } from './busGeometry';
import { isBusDrivableKind } from './roadStyle';

/**
 * Junction ids are the plain integers the snap merge below hands out, and node
 * data is the junction's position — which is also all ngraph.path's distance and
 * heuristic functions need. Links carry nothing: an edge's cost is derived from
 * its endpoints, so there is no per-link weight to store.
 */
export type RoadGraph = Graph<LocalPoint, void>;

/**
 * How close two points from *different* roads must be to count as the same
 * junction. WorldRoad polylines carry no shared intersection identity — each
 * road is projected independently — so a real OSM intersection node shows up as
 * two coordinates a fraction of a meter apart. 2m is well under the smallest
 * real road spacing here and comfortably over that drift.
 */
const DEFAULT_SNAP_EPSILON = 2;

/** Bucketing points into snapEpsilon-sized cells makes the merge O(n) instead of
 * O(n^2) — a corridor fetch can easily hand us tens of thousands of points. */
function cellKey(point: LocalPoint, epsilon: number): string {
  return `${Math.round(point.x / epsilon)}:${Math.round(point.z / epsilon)}`;
}

export function buildRoadGraph(roads: WorldRoad[], snapEpsilon = DEFAULT_SNAP_EPSILON): RoadGraph {
  const graph = createGraph<LocalPoint, void>();
  const points: LocalPoint[] = [];
  const byCell = new Map<string, number[]>();

  const nodeAt = (point: LocalPoint): number => {
    // Check the point's own cell and its 8 neighbours: two points 0.1m apart can
    // still straddle a cell boundary, so the own-cell lookup alone would miss them.
    const cx = Math.round(point.x / snapEpsilon);
    const cz = Math.round(point.z / snapEpsilon);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const candidates = byCell.get(`${cx + dx}:${cz + dz}`);
        if (!candidates) continue;
        for (const index of candidates) {
          const other = points[index];
          if (Math.hypot(other.x - point.x, other.z - point.z) <= snapEpsilon) return index;
        }
      }
    }
    const index = points.length;
    const merged = { x: point.x, z: point.z };
    points.push(merged);
    graph.addNode(index, merged);
    const key = cellKey(point, snapEpsilon);
    const bucket = byCell.get(key);
    if (bucket) bucket.push(index);
    else byCell.set(key, [index]);
    return index;
  };

  const link = (a: number, b: number) => {
    // The graph is undirected, so a link in either direction already connects the
    // pair — addLink would otherwise stack a duplicate every time two roads share
    // a segment, and the pathfinder would relax the same edge repeatedly.
    if (a === b) return;
    if (graph.hasLink(a, b) || graph.hasLink(b, a)) return;
    graph.addLink(a, b);
  };

  for (const road of roads) {
    if (road.points.length < 2) continue;
    // Paved public carriageways only — see isBusDrivableKind.
    if (!isBusDrivableKind(road.kind)) continue;
    let previous = nodeAt(road.points[0]);
    for (let index = 1; index < road.points.length; index += 1) {
      const current = nodeAt(road.points[index]);
      link(previous, current);
      previous = current;
    }
  }

  return graph;
}

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Id of the graph node closest to `point`, or null for an empty graph. Linear —
 * it runs twice per route request, not per frame. */
function nearestNode(graph: RoadGraph, point: LocalPoint): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  graph.forEachNode((node) => {
    const d = distance(node.data, point);
    if (d < bestDistance) {
      bestDistance = d;
      best = node.id as number;
    }
  });
  return best;
}

/**
 * Shortest path between the graph nodes nearest the two picks, via ngraph.path's
 * NBA* — a bidirectional A* that still guarantees the globally optimal path, so
 * the distance and ETA quoted to the player are honest rather than merely
 * plausible. Edge cost is the straight-line distance between the endpoints, which
 * is also the heuristic, so the heuristic can never overestimate.
 */
export function findRoute(graph: RoadGraph, startLocal: LocalPoint, destLocal: LocalPoint): LocalPoint[] | null {
  const start = nearestNode(graph, startLocal);
  const goal = nearestNode(graph, destLocal);
  if (start === null || goal === null) return null;
  if (start === goal) return [graph.getNode(start)!.data];

  const pathFinder = nba<LocalPoint, void>(graph, {
    distance: (from, to) => distance(from.data, to.data),
    heuristic: (from, to) => distance(from.data, to.data),
  });

  const found = pathFinder.find(start, goal);
  if (!found.length) return null;
  // ngraph.path returns the path destination-first; every consumer here walks it
  // from the start.
  return found.map((node) => node.data).reverse();
}

/**
 * Default simplification tolerance, in meters. Sized against what actually produces the
 * jitter: road polylines are Chaikin-smoothed on import (geo.smoothPolyline), which
 * leaves vertices a metre or two apart, and buildRoadGraph then snaps points within
 * DEFAULT_SNAP_EPSILON of each other onto shared junctions. A routed path therefore
 * arrives as a dense chain of ~2m legs whose directions wobble by a few degrees purely
 * from that quantization.
 *
 * That wobble is what buildRideProfile reads as cornering. Its corner radius is
 * `0.5 * min(inLeg, outLeg) / tan(halfAngle)`, so a 2m leg turning a few degrees implies
 * a radius of a few metres, which implies a speed of a few m/s — everywhere, on a
 * straight road. Observed effect: the bus ran the whole opening route at about 6 km/h.
 *
 * Slightly above the snap epsilon, so the quantization is removed and real geometry is
 * not. Comfortably under BUS_CORNER_CUT (3m), the distance the bus is already allowed to
 * cut inside a corner, so nothing here makes the ride leave the carriageway.
 */
export const PATH_SIMPLIFY_TOLERANCE = 2.5;

/**
 * Ramer-Douglas-Peucker: drops every vertex within `tolerance` of the straight line
 * between the vertices that survive around it, keeping both endpoints exactly. Iterative
 * rather than recursive because a long route arrives with thousands of vertices.
 */
export function simplifyPath(path: LocalPoint[], tolerance = PATH_SIMPLIFY_TOLERANCE): LocalPoint[] {
  if (path.length < 3 || tolerance <= 0) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;

  const toleranceSquared = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const a = path[first];
    const b = path[last];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;

    let farthest = -1;
    let farthestSquared = toleranceSquared;
    for (let index = first + 1; index < last; index += 1) {
      const point = path[index];
      // A degenerate span (the route doubling back on itself) has no line to measure
      // against, so fall back to distance from the shared endpoint.
      const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(
        0,
        ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared,
      ));
      const offX = point.x - (a.x + dx * t);
      const offZ = point.z - (a.z + dz * t);
      const distanceSquared = offX * offX + offZ * offZ;
      if (distanceSquared > farthestSquared) {
        farthest = index;
        farthestSquared = distanceSquared;
      }
    }

    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }

  return path.filter((_, index) => keep[index] === 1);
}

/** Total length of a path in meters — the picker's distance readout and its ETA
 * (length / BUS_SPEED) both come from this. */
export function pathLength(path: LocalPoint[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance(path[index - 1], path[index]);
  return total;
}

/** Top cruise speed in m/s (~45 km/h). The bus only reaches this on a long
 * straight — see RideProfile for what actually caps it moment to moment. */
export const BUS_SPEED = 12.5;
/**
 * Pull-away rate, m/s². Deliberately lethargic: this is a long old bus with a big
 * naturally-aspirated engine and a manual box, and the several seconds it takes to reach
 * town speed from a stop is most of what makes it feel like one rather than like a
 * scaled-up car.
 */
export const BUS_ACCEL = 1.15;
/** Comfortable service-brake rate, m/s². Also the rate the backward pass assumes
 * when deciding how early to start slowing for a corner. Drum brakes on a loaded
 * chassis: it sheds speed rather better than it gains it, but not sharply. */
export const BUS_BRAKE = 2.5;
/** Lateral acceleration a seated passenger tolerates, m/s². This is what turns a
 * corner's geometry into a speed: v = sqrt(a_lat * r). Low, because standing
 * passengers on a high-floored bus are what actually sets it. */
export const BUS_LATERAL_ACCEL = 1.3;
/**
 * How far, in meters, the bus is allowed to cut inside a corner of the polyline.
 * Without this the "largest arc that fits between the legs" would let a right-angle
 * junction between two 300m streets be taken on a 150m radius — geometrically
 * valid, but it would sail through the buildings and never slow down. Roughly half
 * a carriageway.
 */
export const BUS_CORNER_CUT = 3;
/** Floor on corner speed — a hairpin in the road graph should slow the bus to a
 * crawl, not to a dead stop it can never leave. */
export const BUS_MIN_CORNER_SPEED = 2.5;
/** The profile drives the target speed to 0 at both ends of the path, so an
 * integrator with no floor would approach the terminus asymptotically and never
 * reach it. This is the creep that guarantees forward progress. */
export const BUS_CREEP_SPEED = 0.5;
/** How close to the path's end counts as arrived, in meters. */
export const RIDE_ARRIVAL_EPSILON = 0.3;

/** Signed angle difference wrapped into (-π, π]. */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/**
 * Precomputed speed plan for one route. `vertexSpeed[i]` is the fastest the bus
 * may be going as it passes vertex `i` while still being able to brake, at
 * BUS_BRAKE, for every corner that comes after it — the standard backward pass
 * used by racing-line and CNC feed planners. With it, the per-frame speed limit
 * is O(log n) instead of a scan over the whole remaining path.
 */
/**
 * One corner of a route whose geometry the bus cannot actually get round: the largest
 * arc that fits the polyline (bounded by BUS_CORNER_CUT the way every corner is, so a
 * flagged corner is not merely tight against an arbitrary cut budget) is still tighter
 * than BUS_DIMENSIONS.minTurnRadius, the radius its front-axle Ackermann lock permits at
 * full steer. See backlog item 2: "no silent corner clipping is accepted".
 */
export interface CornerInfeasibility {
  /** Index into the profile's path/cumulative/vertexSpeed arrays. */
  index: number;
  /** Distance from the route start, in meters — where to point a diagnostic at. */
  atDistance: number;
  /** Largest radius the corner's own geometry admits, in meters. */
  radius: number;
  /** BUS_DIMENSIONS.minTurnRadius: the radius this corner falls short of. */
  minTurnRadius: number;
}

/**
 * Precomputed speed plan for one route. `vertexSpeed[i]` is the fastest the bus
 * may be going as it passes vertex `i` while still being able to brake, at
 * BUS_BRAKE, for every corner that comes after it — the standard backward pass
 * used by racing-line and CNC feed planners. With it, the per-frame speed limit
 * is O(log n) instead of a scan over the whole remaining path.
 */
export interface RideProfile {
  path: LocalPoint[];
  /** Distance from the path start to each vertex; same length as `path`. */
  cumulative: number[];
  vertexSpeed: number[];
  length: number;
  /** Every corner whose geometry is tighter than the bus's minimum turn radius. Empty
   * for a feasible route. A non-empty list still gets a (necessarily optimistic, since
   * the geometry does not actually admit it) speed plan back — buildRideProfile never
   * throws — but a caller must surface this rather than silently starting a ride that
   * will clip the corner; see describeInfeasibility and routeFeasibility. */
  infeasible: CornerInfeasibility[];
}

export function buildRideProfile(path: LocalPoint[]): RideProfile {
  const count = path.length;
  const cumulative = new Array<number>(count).fill(0);
  for (let index = 1; index < count; index += 1) {
    cumulative[index] = cumulative[index - 1] + distance(path[index - 1], path[index]);
  }
  const vertexSpeed = new Array<number>(count).fill(0);
  if (count < 2) return { path, cumulative, vertexSpeed, length: cumulative[count - 1] ?? 0, infeasible: [] };

  // Corner limit per vertex. The bus starts from rest and ends at rest, so the
  // two endpoints are pinned to 0 rather than given a geometric limit.
  const corner = new Array<number>(count).fill(BUS_SPEED);
  corner[0] = 0;
  corner[count - 1] = 0;
  const infeasible: CornerInfeasibility[] = [];
  for (let index = 1; index < count - 1; index += 1) {
    const inLeg = cumulative[index] - cumulative[index - 1];
    const outLeg = cumulative[index + 1] - cumulative[index];
    if (inLeg <= 0 || outLeg <= 0) continue;
    const headingIn = Math.atan2(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z);
    const headingOut = Math.atan2(path[index + 1].x - path[index].x, path[index + 1].z - path[index].z);
    const deviation = Math.abs(wrapAngle(headingOut - headingIn));
    if (deviation < 1e-3) continue;
    // Two independent bounds on the arc the bus can describe through the corner:
    // the largest one that fits between the legs, and the largest one whose sagitta
    // (how far it strays from the vertex) stays within BUS_CORNER_CUT. Deviation is
    // capped short of π so a near-U-turn gives a tiny radius, not a division blow-up.
    const halfAngle = Math.min(deviation, Math.PI - 0.05) / 2;
    const legRadius = (0.5 * Math.min(inLeg, outLeg)) / Math.tan(halfAngle);
    const cutRadius = BUS_CORNER_CUT / (1 - Math.cos(halfAngle));
    const radius = Math.min(legRadius, cutRadius);
    if (radius < BUS_DIMENSIONS.minTurnRadius) {
      infeasible.push({
        index,
        atDistance: cumulative[index],
        radius,
        minTurnRadius: BUS_DIMENSIONS.minTurnRadius,
      });
    }
    corner[index] = Math.min(BUS_SPEED, Math.max(BUS_MIN_CORNER_SPEED, Math.sqrt(BUS_LATERAL_ACCEL * radius)));
  }

  for (let index = count - 2; index >= 0; index -= 1) {
    const leg = cumulative[index + 1] - cumulative[index];
    vertexSpeed[index] = Math.min(corner[index], Math.sqrt(vertexSpeed[index + 1] ** 2 + 2 * BUS_BRAKE * leg));
  }

  return { path, cumulative, vertexSpeed, length: cumulative[count - 1], infeasible };
}

/**
 * Human-readable diagnostic for a route's infeasible corners — what a caller should log
 * or surface rather than letting the bus silently clip the corner at whatever speed
 * buildRideProfile's (necessarily optimistic) plan gives it. Empty string for a feasible
 * route.
 */
export function describeInfeasibility(infeasible: CornerInfeasibility[]): string {
  if (!infeasible.length) return '';
  const worst = infeasible.reduce((min, corner) => (corner.radius < min.radius ? corner : min));
  const plural = infeasible.length === 1 ? '' : 's';
  return (
    `Route has ${infeasible.length} corner${plural} tighter than the bus can turn ` +
    `(worst: ${worst.radius.toFixed(1)}m radius at ${worst.atDistance.toFixed(0)}m, ` +
    `minimum turn radius is ${worst.minTurnRadius.toFixed(1)}m).`
  );
}

/** Fastest the bus may be going `traveled` meters in, given everything ahead of it. */
export function profileSpeedLimit(profile: RideProfile, traveled: number): number {
  const count = profile.path.length;
  if (count < 2) return 0;
  const position = Math.min(Math.max(traveled, 0), profile.length);

  // Last vertex at or before `position`, clamped so `index + 1` is always valid.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (profile.cumulative[middle] <= position) low = middle;
    else high = middle - 1;
  }
  const index = Math.min(low, count - 2);

  const toNextVertex = Math.max(0, profile.cumulative[index + 1] - position);
  return Math.min(BUS_SPEED, Math.sqrt(profile.vertexSpeed[index + 1] ** 2 + 2 * BUS_BRAKE * toNextVertex));
}

/**
 * Seconds the ride will actually take, by integrating the same accelerate/brake
 * rule the runtime uses. `length / BUS_SPEED` would badly under-count a route
 * that is mostly corners, and the picker quotes this number to the player before
 * they commit to the trip.
 */
export function estimateRideDuration(profile: RideProfile): number {
  if (profile.length <= RIDE_ARRIVAL_EPSILON) return 0;
  const step = 0.25;
  let elapsed = 0;
  let traveled = 0;
  let speed = 0;
  // Bounded so a pathological profile can't hang the picker; at the creep floor
  // this still covers a route of ~1.5 km.
  for (let iteration = 0; iteration < 12000 && traveled < profile.length - RIDE_ARRIVAL_EPSILON; iteration += 1) {
    speed = advanceRideSpeed(speed, profileSpeedLimit(profile, traveled), step);
    traveled += speed * step;
    elapsed += step;
  }
  return elapsed;
}

/**
 * One accelerate-or-brake integration step, shared by the runtime and the ETA
 * estimate so the quoted time matches the ride the player gets.
 *
 * `floor` defaults to the creep speed so a mid-route bus never stalls on the
 * profile's asymptotic approach to a corner. Pass 0 when the bus is deliberately
 * pulling up at a stop and must actually reach standstill.
 */
export function advanceRideSpeed(speed: number, limit: number, dt: number, floor = BUS_CREEP_SPEED): number {
  const next = speed < limit
    ? Math.min(limit, speed + BUS_ACCEL * dt)
    : Math.max(limit, speed - BUS_BRAKE * dt);
  return Math.max(floor, next);
}

/** Meters needed to brake from `speed` to standstill at BUS_BRAKE. Used to pick
 * the point a requested stop can actually be made at, rather than stopping dead. */
export function busStopDistance(speed: number): number {
  return (speed * speed) / (2 * BUS_BRAKE);
}

/** Speed ceiling that still allows a full stop `remaining` meters from here. */
export function stoppingSpeedLimit(remaining: number): number {
  return Math.sqrt(Math.max(0, 2 * BUS_BRAKE * remaining));
}

export interface RideSample {
  point: LocalPoint;
  /** Radians, matching the renderer's forward = (sin h, 0, cos h) convention. */
  heading: number;
  arrived: boolean;
}

/**
 * Position and heading `traveled` meters along `path`. Guards both degenerate
 * inputs the picker can legitimately produce: a single-point path (start and
 * destination snapped to the same graph node) and zero-length legs (duplicate
 * points from the snap merge) — neither may divide by zero.
 */
export function sampleRide(path: LocalPoint[], traveled: number): RideSample {
  if (!path.length) return { point: { x: 0, z: 0 }, heading: 0, arrived: true };
  if (path.length === 1) return { point: { x: path[0].x, z: path[0].z }, heading: 0, arrived: true };

  let remaining = Math.max(0, traveled);
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const legLength = distance(from, to);
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    if (legLength <= 0) continue;
    if (remaining <= legLength) {
      const t = remaining / legLength;
      return {
        point: { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t },
        heading,
        arrived: false,
      };
    }
    remaining -= legLength;
  }

  const last = path[path.length - 1];
  const previous = path[path.length - 2];
  return { point: { x: last.x, z: last.z }, heading: Math.atan2(last.x - previous.x, last.z - previous.z), arrived: true };
}
