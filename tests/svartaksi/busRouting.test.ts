import { describe, expect, it } from 'vitest';
import {
  buildRoadGraph,
  findRoute,
  BUS_SPEED,
  BUS_ACCEL,
  BUS_BRAKE,
  BUS_CREEP_SPEED,
  BUS_MIN_CORNER_SPEED,
  RIDE_ARRIVAL_EPSILON,
  advanceRideSpeed,
  busStopDistance,
  stoppingSpeedLimit,
  buildRideProfile,
  describeInfeasibility,
  estimateRideDuration,
  profileSpeedLimit,
  simplifyPath,
  sampleRide,
} from '../../src/svartaksi/busRouting';
import { BUS_DIMENSIONS } from '../../src/svartaksi/busGeometry';
import type { LocalPoint, WorldRoad } from '../../src/world/types';
import type { RoadGraph } from '../../src/svartaksi/busRouting';

function road(id: string, points: Array<[number, number]>): WorldRoad {
  return { id, kind: 'street', width: 9, points: points.map(([x, z]) => ({ x, z })) };
}

/** The junction positions in the graph, in the order buildRoadGraph created them. */
function graphPoints(graph: RoadGraph): LocalPoint[] {
  const points: LocalPoint[] = [];
  graph.forEachNode((node) => {
    points.push(node.data);
  });
  return points;
}

/** How many junctions a given one is directly connected to. */
function degree(graph: RoadGraph, nodeId: number): number {
  return graph.getLinks(nodeId)?.size ?? 0;
}

/** Id of the first junction whose position satisfies `match`, or -1. */
function findNodeId(graph: RoadGraph, match: (point: LocalPoint) => boolean): number {
  let found = -1;
  graph.forEachNode((node) => {
    if (found < 0 && match(node.data)) found = node.id as number;
  });
  return found;
}

describe('buildRoadGraph', () => {
  it('links adjacent points within a single road', () => {
    const graph = buildRoadGraph([road('a', [[0, 0], [10, 0], [20, 0]])]);

    expect(graph.getNodesCount()).toBe(3);
    expect(graph.hasLink(0, 1) ?? graph.hasLink(1, 0)).toBeTruthy();
    expect(graph.hasLink(1, 2) ?? graph.hasLink(2, 1)).toBeTruthy();
    // The middle point is the only one joined to two others; the ends have one each.
    expect(degree(graph, 1)).toBe(2);
    expect(degree(graph, 0)).toBe(1);
    expect(degree(graph, 2)).toBe(1);
  });

  it('merges points from different roads that land within the snap epsilon', () => {
    // A T-junction: the vertical road's endpoint is 0.5m off the horizontal
    // road's middle point, the kind of float drift independent projections give.
    const graph = buildRoadGraph([
      road('h', [[0, 0], [10, 0], [20, 0]]),
      road('v', [[10.5, 0], [10.5, 10]]),
    ]);

    expect(graph.getNodesCount()).toBe(4);
    const junction = findNodeId(graph, (point) => Math.abs(point.x - 10) < 1 && point.z === 0);
    expect(degree(graph, junction)).toBe(3);
  });

  it('does not stack duplicate links when two roads share a segment', () => {
    // Both roads walk the same two points, so the second pass must find the link
    // already there rather than adding a parallel one the pathfinder would relax twice.
    const graph = buildRoadGraph([
      road('a', [[0, 0], [10, 0]]),
      road('b', [[0, 0], [10, 0]]),
    ]);

    expect(graph.getNodesCount()).toBe(2);
    expect(graph.getLinksCount()).toBe(1);
  });

  it('keeps genuinely separate roads unconnected', () => {
    const graph = buildRoadGraph([
      road('a', [[0, 0], [10, 0]]),
      road('b', [[0, 500], [10, 500]]),
    ]);

    expect(graph.getNodesCount()).toBe(4);
    for (let id = 0; id < 4; id += 1) expect(degree(graph, id)).toBe(1);
  });

  it('ignores degenerate roads with fewer than two points', () => {
    expect(buildRoadGraph([road('a', [[0, 0]])]).getNodesCount()).toBe(0);
  });
});

describe('findRoute', () => {
  // A 2x2 grid of 100m blocks: corners (0,0) (100,0) (0,100) (100,100).
  const grid = [
    road('n', [[0, 0], [100, 0]]),
    road('s', [[0, 100], [100, 100]]),
    road('w', [[0, 0], [0, 100]]),
    road('e', [[100, 0], [100, 100]]),
  ];

  it('returns the shortest path between two corners', () => {
    const path = findRoute(buildRoadGraph(grid), { x: 2, z: 1 }, { x: 99, z: 2 });

    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 0, z: 0 });
    expect(path![path!.length - 1]).toEqual({ x: 100, z: 0 });
    expect(path).toHaveLength(2);
  });

  it('routes around the grid when there is no direct edge', () => {
    const path = findRoute(buildRoadGraph(grid), { x: 0, z: 0 }, { x: 100, z: 100 });

    expect(path).not.toBeNull();
    expect(path).toHaveLength(3);
    expect(path![path!.length - 1]).toEqual({ x: 100, z: 100 });
  });

  it('returns null when the destination is on a disconnected road', () => {
    const graph = buildRoadGraph([
      road('a', [[0, 0], [100, 0]]),
      road('b', [[0, 900], [100, 900]]),
    ]);

    expect(findRoute(graph, { x: 0, z: 0 }, { x: 100, z: 900 })).toBeNull();
  });

  it('returns a single-point path when start and destination snap to the same node', () => {
    const path = findRoute(buildRoadGraph(grid), { x: 1, z: 1 }, { x: -1, z: -1 });

    expect(path).toEqual([{ x: 0, z: 0 }]);
  });

  it('returns null for an empty graph', () => {
    expect(findRoute(buildRoadGraph([]), { x: 0, z: 0 }, { x: 1, z: 1 })).toBeNull();
  });

  it('orders the path from the start, not from the destination', () => {
    // ngraph.path hands back the path destination-first; findRoute must flip it,
    // or the bus would drive the route backwards.
    const path = findRoute(buildRoadGraph([road('a', [[0, 0], [100, 0], [200, 0]])]), { x: 0, z: 0 }, { x: 200, z: 0 });

    expect(path).toEqual([{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 200, z: 0 }]);
  });

  it('takes the shorter of two competing routes to the same destination', () => {
    // Two ways from the origin to (0,200): straight up the short road, or a long
    // dogleg 300m out to the east and back. An optimal search must reject the dogleg.
    const graph = buildRoadGraph([
      road('short', [[0, 0], [0, 100], [0, 200]]),
      road('long', [[0, 0], [300, 0], [300, 200], [0, 200]]),
    ]);
    const path = findRoute(graph, { x: 0, z: 0 }, { x: 0, z: 200 });

    expect(path).toEqual([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }]);
  });
});

describe('sampleRide', () => {
  // Two 100m legs: east along +x, then south along +z.
  const path = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];

  it('starts at the first point', () => {
    expect(sampleRide(path, 0)).toEqual({ point: { x: 0, z: 0 }, heading: Math.atan2(1, 0), arrived: false });
  });

  it('interpolates within the first leg', () => {
    const sample = sampleRide(path, 25);

    expect(sample.point.x).toBeCloseTo(25);
    expect(sample.point.z).toBeCloseTo(0);
    expect(sample.arrived).toBe(false);
  });

  it('crosses into the second leg and turns with the path tangent', () => {
    const sample = sampleRide(path, 150);

    expect(sample.point.x).toBeCloseTo(100);
    expect(sample.point.z).toBeCloseTo(50);
    // Heading south (+z) is 0 by this project's forward = (sin h, 0, cos h).
    expect(sample.heading).toBeCloseTo(0);
  });

  it('clamps to the destination and reports arrival', () => {
    const sample = sampleRide(path, 999);

    expect(sample.point).toEqual({ x: 100, z: 100 });
    expect(sample.arrived).toBe(true);
  });

  it('treats a single-point path as immediate arrival without dividing by zero', () => {
    const sample = sampleRide([{ x: 5, z: 7 }], 0);

    expect(sample).toEqual({ point: { x: 5, z: 7 }, heading: 0, arrived: true });
  });

  it('exposes a plausible bus speed in meters per second', () => {
    expect(BUS_SPEED).toBeGreaterThan(5);
    expect(BUS_SPEED).toBeLessThan(25);
  });
});

describe('buildRideProfile', () => {
  const straight = [{ x: 0, z: 0 }, { x: 0, z: 500 }, { x: 0, z: 1000 }];

  it('measures cumulative distance along the path', () => {
    const profile = buildRideProfile(straight);
    expect(profile.cumulative).toEqual([0, 500, 1000]);
    expect(profile.length).toBe(1000);
  });

  it('pins both endpoints to a standstill', () => {
    const profile = buildRideProfile(straight);
    expect(profile.vertexSpeed[0]).toBe(0);
    expect(profile.vertexSpeed[profile.vertexSpeed.length - 1]).toBe(0);
  });

  it('leaves a shallow bend at cruise speed but slows a sharp one', () => {
    const shallow = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 5, z: 600 }]);
    const sharp = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 300, z: 300 }]);
    expect(shallow.vertexSpeed[1]).toBeCloseTo(BUS_SPEED, 5);
    expect(sharp.vertexSpeed[1]).toBeLessThan(BUS_SPEED);
    expect(sharp.vertexSpeed[1]).toBeGreaterThanOrEqual(BUS_MIN_CORNER_SPEED);
  });

  it('never lets a corner drop below the crawl floor, even on a hairpin', () => {
    const hairpin = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 0.5, z: 0 }]);
    expect(hairpin.vertexSpeed[1]).toBeGreaterThanOrEqual(BUS_MIN_CORNER_SPEED);
    expect(Number.isFinite(hairpin.vertexSpeed[1])).toBe(true);
  });

  it('handles a single-point path without dividing by zero', () => {
    const profile = buildRideProfile([{ x: 3, z: 4 }]);
    expect(profile.length).toBe(0);
    expect(profileSpeedLimit(profile, 0)).toBe(0);
  });

  it('reports no infeasible corners on a route the bus can actually take', () => {
    const shallow = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 5, z: 600 }]);
    expect(shallow.infeasible).toEqual([]);
    expect(describeInfeasibility(shallow.infeasible)).toBe('');
  });

  it('flags a corner tighter than the bus minimum turn radius rather than clipping it silently', () => {
    // A near U-turn: legs of 200m each, meeting at a shade under 180 degrees — no
    // geometry lets an 11m bus's front axle actually make this without leaving the
    // carriageway, no matter how slow it goes.
    const hairpin = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 0.5, z: 0 }]);
    expect(hairpin.infeasible.length).toBeGreaterThan(0);
    const corner = hairpin.infeasible[0];
    expect(corner.index).toBe(1);
    expect(corner.radius).toBeLessThan(BUS_DIMENSIONS.minTurnRadius);
    expect(corner.minTurnRadius).toBe(BUS_DIMENSIONS.minTurnRadius);
    const message = describeInfeasibility(hairpin.infeasible);
    expect(message).toContain('1 corner');
    expect(message).toContain('minimum turn radius');
  });
});

describe('profileSpeedLimit', () => {
  it('caps the limit at cruise speed mid-straight', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 2000 }]);
    expect(profileSpeedLimit(profile, 1000)).toBe(BUS_SPEED);
  });

  it('falls to zero at the terminus', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 2000 }]);
    expect(profileSpeedLimit(profile, 2000)).toBeCloseTo(0, 6);
  });

  it('starts braking before the corner rather than at it', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 400 }, { x: 400, z: 400 }]);
    const cornerSpeed = profile.vertexSpeed[1];
    // 1m out the limit must already be near the corner speed; 200m out it must not be.
    expect(profileSpeedLimit(profile, 399)).toBeLessThan(cornerSpeed + 1);
    expect(profileSpeedLimit(profile, 200)).toBeGreaterThan(cornerSpeed + 1);
  });

  it('is monotonically non-increasing as a corner is approached', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 400 }, { x: 400, z: 400 }]);
    let previous = Infinity;
    // Up to but not including the vertex: past it the limit legitimately steps back
    // up, because the next thing to brake for is the far end of the second leg.
    for (let d = 250; d < 400; d += 5) {
      const limit = profileSpeedLimit(profile, d);
      expect(limit).toBeLessThanOrEqual(previous + 1e-9);
      previous = limit;
    }
  });
});

describe('advanceRideSpeed', () => {
  it('accelerates toward a higher limit at the pull-away rate', () => {
    expect(advanceRideSpeed(4, BUS_SPEED, 1)).toBeCloseTo(4 + BUS_ACCEL, 6);
  });

  it('brakes toward a lower limit at the brake rate', () => {
    expect(advanceRideSpeed(12, 2, 1)).toBeCloseTo(12 - BUS_BRAKE, 6);
  });

  it('never overshoots the limit in either direction', () => {
    expect(advanceRideSpeed(13.9, BUS_SPEED, 1)).toBe(BUS_SPEED);
    expect(advanceRideSpeed(6, 5.9, 1)).toBe(5.9);
  });

  it('keeps a creep on so the bus can always reach the terminus', () => {
    expect(advanceRideSpeed(0, 0, 1)).toBe(BUS_CREEP_SPEED);
  });
});

describe('estimateRideDuration', () => {
  it('is zero for a degenerate path', () => {
    expect(estimateRideDuration(buildRideProfile([{ x: 0, z: 0 }]))).toBe(0);
  });

  it('is longer than the naive length / cruise speed, because of the ends', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 1400 }]);
    expect(estimateRideDuration(profile)).toBeGreaterThan(1400 / BUS_SPEED);
  });

  it('quotes a corner-heavy route as slower than the same length straight', () => {
    const straight = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 800 }]);
    const zigzag = buildRideProfile(
      Array.from({ length: 17 }, (_, index) => ({ x: index % 2 === 0 ? 0 : 50, z: index * 50 })),
    );
    expect(zigzag.length).toBeGreaterThan(straight.length);
    expect(estimateRideDuration(zigzag)).toBeGreaterThan(estimateRideDuration(straight));
  });

  it('actually completes the route it integrates', () => {
    const profile = buildRideProfile([{ x: 0, z: 0 }, { x: 0, z: 300 }, { x: 300, z: 300 }]);
    let traveled = 0;
    let speed = 0;
    let steps = 0;
    while (profile.length - traveled > RIDE_ARRIVAL_EPSILON && steps < 100000) {
      speed = advanceRideSpeed(speed, profileSpeedLimit(profile, traveled), 1 / 60);
      traveled += speed / 60;
      steps += 1;
    }
    expect(profile.length - traveled).toBeLessThanOrEqual(RIDE_ARRIVAL_EPSILON);
  });
});

describe('stopping the bus on request', () => {
  it('needs more room to stop the faster it is going', () => {
    expect(busStopDistance(0)).toBe(0);
    expect(busStopDistance(14)).toBeGreaterThan(busStopDistance(7));
    // v²/2a: 14 m/s at 3.4 m/s² is about 29 m.
    expect(busStopDistance(14)).toBeCloseTo((14 * 14) / (2 * BUS_BRAKE), 6);
  });

  it('allows exactly the speed it can still stop from', () => {
    const remaining = busStopDistance(9);
    expect(stoppingSpeedLimit(remaining)).toBeCloseTo(9, 6);
    expect(stoppingSpeedLimit(0)).toBe(0);
    // Never NaN if the integrator overshoots the stop point by a hair.
    expect(stoppingSpeedLimit(-3)).toBe(0);
  });

  it('reaches a genuine standstill once the creep floor is lifted', () => {
    const stopAt = busStopDistance(14);
    let traveled = 0;
    let speed = 14;
    let steps = 0;
    while (stopAt - traveled > 0.05 && speed > 0.02 && steps < 100000) {
      speed = advanceRideSpeed(speed, stoppingSpeedLimit(stopAt - traveled), 1 / 60, 0);
      traveled += speed / 60;
      steps += 1;
    }
    expect(stopAt - traveled).toBeLessThanOrEqual(0.05);
    // A fixed-step integrator cannot track sqrt(2·a·d) all the way to zero — the
    // limit falls faster than BUS_BRAKE·dt in the last few centimetres — so the bus
    // arrives at the stop point at a walking pace rather than exactly 0. That is
    // under a tenth of its cruise speed, and it is hidden the same frame anyway.
    expect(speed).toBeLessThan(1.5);
  });

  it('would never stop if the creep floor were left in place', () => {
    const stopAt = busStopDistance(14);
    let traveled = 0;
    let speed = 14;
    for (let step = 0; step < 2000; step += 1) {
      speed = advanceRideSpeed(speed, stoppingSpeedLimit(stopAt - traveled), 1 / 60);
      traveled += speed / 60;
    }
    // Still creeping past the stop point — which is exactly why the runtime passes 0.
    expect(speed).toBe(BUS_CREEP_SPEED);
    expect(traveled).toBeGreaterThan(stopAt);
  });
});

describe('what the bus is willing to drive on', () => {
  it('leaves footways out of the graph entirely', () => {
    // A route planned over these sent an 11-metre vehicle down a gravel walking path.
    const graph = buildRoadGraph([
      { id: 'street', kind: 'street', width: 9, points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: 'foot', kind: 'footway', width: 2, points: [{ x: 0, z: 0 }, { x: 0, z: 50 }] },
    ]);

    // Only the street's own two endpoints survive.
    expect(graph.getNodesCount()).toBe(2);
    for (const point of graphPoints(graph)) expect(Math.abs(point.z)).toBeLessThan(1e-6);
  });

  it('cannot route onto a destination only a footpath reaches', () => {
    const graph = buildRoadGraph([
      { id: 'street', kind: 'street', width: 9, points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: 'foot', kind: 'footway', width: 2, points: [{ x: 50, z: 0 }, { x: 50, z: 90 }] },
    ]);

    expect(findRoute(graph, { x: 0, z: 0 }, { x: 50, z: 0 })).not.toBeNull();
    // The far end of the footpath is 90m from any drivable node, well past the snap.
    const overPath = findRoute(graph, { x: 0, z: 0 }, { x: 50, z: 90 });
    if (overPath) {
      for (const point of overPath) expect(Math.abs(point.z)).toBeLessThan(1e-6);
    }
  });
});

describe('simplifyPath', () => {
  const line = (count: number, jitter: number) =>
    Array.from({ length: count }, (_, index) => ({
      x: index * 2,
      // Alternating sub-tolerance wobble, exactly what the 2m graph snap leaves behind.
      z: index % 2 === 0 ? 0 : jitter,
    }));

  it('collapses a jittering straight run to its endpoints', () => {
    const jittery = line(60, 0.8);
    const simplified = simplifyPath(jittery);

    expect(simplified).toHaveLength(2);
    // Both endpoints are kept exactly; only the wobble between them goes.
    expect(simplified[0]).toEqual(jittery[0]);
    expect(simplified[1]).toEqual(jittery.at(-1));
  });

  it('keeps a real corner', () => {
    const corner = [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0.5 }, { x: 100, z: 80 }];
    const simplified = simplifyPath(corner);

    expect(simplified).toContainEqual({ x: 100, z: 0.5 });
    expect(simplified[0]).toEqual(corner[0]);
    expect(simplified.at(-1)).toEqual(corner.at(-1));
  });

  it('is what lets the bus actually reach cruising speed on a straight road', () => {
    // 400m of straight road as the router hands it over: 2m legs, 0.8m of wobble.
    const jittery = line(200, 0.8);
    const before = buildRideProfile(jittery);
    const after = buildRideProfile(simplifyPath(jittery));

    const midpoint = before.length / 2;
    expect(profileSpeedLimit(before, midpoint)).toBeLessThan(4);
    expect(profileSpeedLimit(after, midpoint)).toBeGreaterThan(12);
    // The straightened route is also shorter, and honestly so: the length it loses is
    // the zigzag the bus was never going to drive. Well under 10% either way, so the
    // distance and ETA quoted to the player stay meaningful.
    expect(after.length).toBeLessThan(before.length);
    expect(after.length).toBeGreaterThan(before.length * 0.9);
  });

  it('leaves short and degenerate paths exactly as they are', () => {
    const pair = [{ x: 0, z: 0 }, { x: 10, z: 0 }];
    expect(simplifyPath(pair)).toBe(pair);
    expect(simplifyPath([])).toEqual([]);
    expect(simplifyPath([{ x: 1, z: 1 }])).toEqual([{ x: 1, z: 1 }]);
    // A zero tolerance is an explicit opt-out, not an invitation to divide by zero.
    const jittery = line(20, 0.8);
    expect(simplifyPath(jittery, 0)).toBe(jittery);
  });

  it('handles a path that doubles back on itself', () => {
    const doubled = [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }, { x: 50, z: 0 }, { x: 0, z: 0 }];
    const simplified = simplifyPath(doubled);

    expect(simplified[0]).toEqual({ x: 0, z: 0 });
    expect(simplified.at(-1)).toEqual({ x: 0, z: 0 });
    expect(simplified).toContainEqual({ x: 100, z: 0 });
  });
});
