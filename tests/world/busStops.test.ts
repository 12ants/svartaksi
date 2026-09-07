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


/**
 * The shape of the walk, frozen: these coordinates were recorded from the eager
 * implementation before it was cut into slices, so the incremental form has something to
 * be compared against that is not simply another run of itself.
 *
 * The network is deliberately awkward — a 4km primary crossed every 400m (candidates
 * that land back on pavement), a road carrying a zero-length segment, a kind buses never
 * serve, and a building sitting on the kerb — so a mistake in where the walk pauses
 * shows up as a missing or moved shelter rather than as an equal-length list.
 */
const FROZEN_STOPS: [number, number, number][] = [
  [160, 9.2, 3.141593],
  [480, -9.2, 0],
  [1120, -9.2, 0],
  [1440, 9.2, 3.141593],
  [1760, -9.2, 0],
  [2080, 9.2, 3.141593],
  [2720, 9.2, 3.141593],
  [3040, -9.2, 0],
  [3360, 9.2, 3.141593],
  [3680, -9.2, 0],
  [4000, 9.2, 3.141593],
  [-9.2, -140, 1.570796],
  [9.2, 180, -1.570796],
  [390.8, -140, 1.570796],
  [409.2, 180, -1.570796],
  [790.8, -140, 1.570796],
  [809.2, 180, -1.570796],
  [1190.8, -140, 1.570796],
  [1209.2, 180, -1.570796],
  [1590.8, -140, 1.570796],
  [1609.2, 180, -1.570796],
  [1990.8, -140, 1.570796],
  [2009.2, 180, -1.570796],
  [2390.8, -140, 1.570796],
  [2409.2, 180, -1.570796],
  [2790.8, -140, 1.570796],
  [2809.2, 180, -1.570796],
  [3190.8, -140, 1.570796],
  [3209.2, 180, -1.570796],
  [3590.8, -140, 1.570796],
  [3609.2, 180, -1.570796],
  [160, 907.7, 3.141593],
  [480, 892.3, 0],
  [800, 907.7, 3.141593],
  [1120, 892.3, 0],
];

describe('generateBusStops on a crossing network', () => {
  const network: WorldRoad[] = [
    { id: 'long', kind: 'primary', width: 12, points: [{ x: 0, z: 0 }, { x: 4000, z: 0 }] },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `cross-${index}`,
      kind: 'primary',
      width: 12,
      points: [{ x: index * 400, z: -300 }, { x: index * 400, z: 300 }],
    })),
    { id: 'degenerate', kind: 'secondary', width: 9, points: [{ x: 0, z: 900 }, { x: 0, z: 900 }, { x: 1200, z: 900 }] },
    { id: 'skipped', kind: 'motorway', width: 20, points: [{ x: 0, z: 1800 }, { x: 3000, z: 1800 }] },
  ];
  const blocks: WorldBuilding[] = [{
    id: 'block',
    height: 12,
    properties: {},
    rings: [[{ x: 1100, z: 4 }, { x: 1300, z: 4 }, { x: 1300, z: 40 }, { x: 1100, z: 40 }, { x: 1100, z: 4 }]],
  }];

  it('reproduces the recorded placements exactly', () => {
    const stops = generateBusStops(network, blocks);

    expect(stops.map((stop) => [
      Number(stop.x.toFixed(6)), Number(stop.z.toFixed(6)), Number(stop.yaw.toFixed(6)),
    ])).toEqual(FROZEN_STOPS);
  });
});
