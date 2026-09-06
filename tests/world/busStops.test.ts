import { describe, expect, it } from 'vitest';
import { BUS_STOP_SPACING, generateBusStops } from '../../src/world/busStops';
import type { WorldBuilding, WorldRoad } from '../../src/world/types';

const straight = (kind: string, length = 1000, width = 10): WorldRoad => ({
  id: `road:${kind}`, kind, width,
  points: [{ x: 0, z: 0 }, { x: length, z: 0 }],
});

describe('generateBusStops', () => {
  it('places shelters at a fixed spacing, offset half a spacing from the road start', () => {
    const stops = generateBusStops([straight('primary')]);
    expect(stops.length).toBeGreaterThan(1);
    for (const [index, stop] of stops.entries()) {
      expect(stop.x).toBeCloseTo(BUS_STOP_SPACING / 2 + index * BUS_STOP_SPACING);
    }
  });

  it('alternates sides of the centerline and clears the paved width', () => {
    const stops = generateBusStops([straight('secondary', 1000, 10)]);
    expect(Math.sign(stops[0].z)).not.toBe(Math.sign(stops[1].z));
    for (const stop of stops) expect(Math.abs(stop.z)).toBeGreaterThan(5);
  });

  it('faces each shelter across the road it serves', () => {
    const stops = generateBusStops([straight('primary')]);
    for (const stop of stops) {
      // Local +Z rotated by yaw is the direction the open side looks; it must point
      // back toward the centerline (z = 0), not away from it.
      const facingZ = Math.cos(stop.yaw);
      expect(Math.sign(facingZ)).toBe(-Math.sign(stop.z));
      // And along the road, not across it: the shelter's back is parallel to the kerb.
      expect(Math.sin(stop.yaw)).toBeCloseTo(0);
    }
  });

  it('skips road kinds a bus route does not run on', () => {
    for (const kind of ['footway', 'cycleway', 'motorway', 'trunk', 'service', 'residential']) {
      expect(generateBusStops([straight(kind)])).toHaveLength(0);
    }
  });

  it('skips roads too short to be a served route', () => {
    expect(generateBusStops([straight('primary', 80)])).toHaveLength(0);
  });

  it('rejects a placement that lands on another road', () => {
    const route = straight('primary', 1000, 10);
    const first = generateBusStops([route])[0];
    const crossing: WorldRoad = {
      id: 'crossing', kind: 'residential', width: 30,
      points: [{ x: first.x, z: -60 }, { x: first.x, z: 60 }],
    };
    const stops = generateBusStops([route, crossing]);
    expect(stops.some((stop) => stop.x === first.x && stop.z === first.z)).toBe(false);
  });

  it('rejects a placement whose footprint reaches into a building', () => {
    const route = straight('primary', 1000, 10);
    const first = generateBusStops([route])[0];
    const reaching: WorldBuilding = {
      id: 'blocker', height: 6, properties: {},
      rings: [[
        { x: first.x - 5, z: first.z - 5 }, { x: first.x + 5, z: first.z - 5 },
        { x: first.x + 5, z: first.z + 5 }, { x: first.x - 5, z: first.z + 5 },
      ]],
    };
    const stops = generateBusStops([route], [reaching]);
    expect(stops.some((stop) => stop.x === first.x && stop.z === first.z)).toBe(false);
    // Unaffected without the building, which is what confirms the rejection above is
    // actually caused by it rather than some other placement quirk.
    expect(generateBusStops([route]).some((stop) => stop.x === first.x && stop.z === first.z)).toBe(true);
  });

  it('carries spacing across a multi-segment road and is deterministic', () => {
    const road: WorldRoad = {
      id: 'bend', kind: 'tertiary', width: 8,
      points: [{ x: 0, z: 0 }, { x: 500, z: 0 }, { x: 500, z: 500 }],
    };
    const stops = generateBusStops([road]);
    expect(stops).toHaveLength(Math.floor((1000 - BUS_STOP_SPACING / 2) / BUS_STOP_SPACING) + 1);
    expect(generateBusStops([road])).toEqual(stops);
  });

  it('ignores degenerate roads', () => {
    expect(generateBusStops([{ id: 'a', kind: 'primary', width: 8, points: [{ x: 0, z: 0 }] }])).toHaveLength(0);
    expect(generateBusStops([{ id: 'b', kind: 'primary', width: 8, points: [] }])).toHaveLength(0);
  });
});
