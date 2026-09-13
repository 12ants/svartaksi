import { describe, expect, it } from 'vitest';

import { ARRIVAL_RIDE_METERS, planArrivalRide } from '../../src/svartaksi/introArrival';
import { buildRideProfile, pathLength } from '../../src/svartaksi/busRouting';
import type { WorldRoad } from '../../src/world/types';

/** A straight carriageway of `count` vertices `spacing` metres apart, running along +x at
 * the given z. Enough to exercise the walk-back without bringing in a real OSM fixture. */
function straightRoad(id: string, z: number, count: number, spacing = 10, kind = 'secondary'): WorldRoad {
  return {
    id,
    kind,
    width: 7,
    points: Array.from({ length: count }, (_, i) => ({ x: i * spacing, z })),
  };
}

describe('planning the arrival ride', () => {
  it('finishes at the drivable vertex nearest the parked car', () => {
    const road = straightRoad('street', 0, 60);
    const plan = planArrivalRide([road], { x: 300, z: 12 })!;
    expect(plan).not.toBeNull();
    const last = plan.path[plan.path.length - 1];
    expect(last.x).toBeCloseTo(300, 6);
    expect(last.z).toBeCloseTo(0, 6);
    // The walk the player is left with, reported rather than hidden.
    expect(plan.stopDistance).toBeCloseTo(12, 6);
  });

  it('runs for about the requested distance', () => {
    const plan = planArrivalRide([straightRoad('street', 0, 120)], { x: 900, z: 5 })!;
    const length = pathLength(plan.path);
    expect(length).toBeGreaterThanOrEqual(ARRIVAL_RIDE_METERS);
    // One segment of overshoot at most — the walk stops as soon as the budget is met.
    expect(length).toBeLessThan(ARRIVAL_RIDE_METERS + 15);
  });

  it('approaches the stop rather than driving away from it', () => {
    const plan = planArrivalRide([straightRoad('street', 0, 120)], { x: 900, z: 0 })!;
    const first = plan.path[0];
    const last = plan.path[plan.path.length - 1];
    expect(Math.abs(last.x - 900)).toBeLessThan(Math.abs(first.x - 900));
  });

  it('takes the long way round when the stop sits near one end of the street', () => {
    // Landing at index 2 of 80: there is almost no road behind the stop in one direction,
    // so the ride has to be built from the other.
    const plan = planArrivalRide([straightRoad('street', 0, 80)], { x: 20, z: 1 })!;
    expect(pathLength(plan.path)).toBeGreaterThan(100);
    expect(plan.path[plan.path.length - 1].x).toBeCloseTo(20, 6);
  });

  it('produces a path the bus can actually profile and drive', () => {
    const plan = planArrivalRide([straightRoad('street', 0, 120)], { x: 900, z: 5 })!;
    const profile = buildRideProfile(plan.path);
    expect(profile.infeasible).toEqual([]);
    expect(profile.length).toBeGreaterThan(0);
  });

  it('ignores roads a bus has no business on', () => {
    const footway = straightRoad('path', 0, 60, 10, 'footway');
    // The footway passes right beside the target; the street is far away but drivable.
    const street = straightRoad('street', 400, 60);
    const plan = planArrivalRide([footway, street], { x: 300, z: 2 })!;
    expect(plan.path[plan.path.length - 1].z).toBeCloseTo(400, 6);
  });

  it('gives up rather than returning a lurch when there is no road to use', () => {
    expect(planArrivalRide([], { x: 0, z: 0 })).toBeNull();
    // A drivable road too short to be a ride.
    expect(planArrivalRide([straightRoad('stub', 0, 3)], { x: 0, z: 0 })).toBeNull();
    // Nothing drivable at all.
    expect(planArrivalRide([straightRoad('path', 0, 60, 10, 'footway')], { x: 0, z: 0 })).toBeNull();
  });
});
