import { describe, expect, it } from 'vitest';
import { LAMP_SPACING, generateStreetLights } from '../../src/world/streetLights';
import type { WorldBuilding, WorldRoad } from '../../src/world/types';

describe('generateStreetLights', () => {
  it('places posts at a fixed spacing along a straight road, alternating sides of the centerline', () => {
    const road: WorldRoad = {
      id: 'road', kind: 'residential', width: 8,
      points: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
    };
    const lights = generateStreetLights([road]);

    // A 100m road placed every LAMP_SPACING meters starting at 0.
    const expectedCount = Math.floor(100 / LAMP_SPACING) + 1;
    expect(lights).toHaveLength(expectedCount);
    for (const [index, lamp] of lights.entries()) {
      expect(lamp.x).toBeCloseTo(index * LAMP_SPACING);
      expect(lamp.z).not.toBeCloseTo(0);
    }
    // Alternates left/right of the road centerline.
    expect(Math.sign(lights[0].z)).not.toBe(Math.sign(lights[1].z));
    // Offset clears the paved width (half of 8 = 4) plus a setback margin.
    for (const lamp of lights) expect(Math.abs(lamp.z)).toBeGreaterThan(4);
  });

  it('skips pedestrian-scale ways (paths/footways/cycleways)', () => {
    const path: WorldRoad = {
      id: 'path', kind: 'footway', width: 2,
      points: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
    };
    expect(generateStreetLights([path])).toHaveLength(0);
  });

  it('rejects a post whose spot reaches into a building footprint', () => {
    const road: WorldRoad = { id: 'road', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    const first = generateStreetLights([road])[0];
    const reaching: WorldBuilding = {
      id: 'blocker', height: 6, properties: {},
      rings: [[
        { x: first.x - 3, z: first.z - 3 }, { x: first.x + 3, z: first.z - 3 },
        { x: first.x + 3, z: first.z + 3 }, { x: first.x - 3, z: first.z + 3 },
      ]],
    };
    const lights = generateStreetLights([road], [reaching]);
    expect(lights.some((lamp) => lamp.x === first.x && lamp.z === first.z)).toBe(false);
    expect(generateStreetLights([road]).some((lamp) => lamp.x === first.x && lamp.z === first.z)).toBe(true);
  });

  it('stands a post on the surface under it rather than at y=0', () => {
    const road: WorldRoad = { id: 'road', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    const flat = generateStreetLights([road]);
    for (const lamp of flat) expect(lamp.y).toBe(0);

    // A landuse mound under the verge: the post is planted on top of it, not buried in it.
    const mounded = generateStreetLights([road], [], { groundHeightAt: () => 1.1 });
    expect(mounded).toHaveLength(flat.length);
    for (const lamp of mounded) expect(lamp.y).toBeCloseTo(1.1);
    // The mound moves nothing horizontally — this is a height, not a placement rule.
    expect(mounded.map((lamp) => [lamp.x, lamp.z])).toEqual(flat.map((lamp) => [lamp.x, lamp.z]));
  });

  it('mounts a post on a bridge deck, inboard of the paved edge and at the deck\'s own height', () => {
    const road: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
    };
    const lights = generateStreetLights([road], [], {
      groundHeightAt: () => 0,
      deckHeightAlong: () => 6,
    });
    expect(lights.length).toBeGreaterThan(0);
    for (const lamp of lights) {
      expect(lamp.onDeck).toBe(true);
      // On the deck, not floating off its side where a street verge would be...
      expect(Math.abs(lamp.z)).toBeLessThan(road.width / 2);
      expect(Math.abs(lamp.z)).toBeGreaterThan(1);
      // ...and standing on it rather than on the water underneath.
      expect(lamp.y).toBe(6);
    }
  });

  it('keeps deck posts even where the deck itself is the only pavement around', () => {
    // isPavementClear rejects any point on a carriageway, which is exactly where a deck
    // post has to be — the check is skipped there rather than silently dropping every
    // lamp on every bridge.
    const road: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
    };
    const onDeck = generateStreetLights([road], [], { deckHeightAlong: () => 6 });
    const atGrade = generateStreetLights([road], [], { deckHeightAlong: () => 0.17 });
    expect(onDeck.length).toBeGreaterThan(0);
    expect(atGrade.every((lamp) => !lamp.onDeck)).toBe(true);
  });

  it('does not hoist a lamp onto a deck that merely passes overhead', () => {
    // The street under a viaduct has its own profile only where it is genuinely lifted;
    // asking per road (rather than per point) is what keeps its verge lamps on the ground.
    const under: WorldRoad = { id: 'under', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    const lights = generateStreetLights([under], [], {
      groundHeightAt: () => 0,
      deckHeightAlong: (road) => (road.id === 'under' ? null : 6),
    });
    expect(lights.length).toBeGreaterThan(0);
    for (const lamp of lights) {
      expect(lamp.onDeck).toBe(false);
      expect(lamp.y).toBe(0);
      expect(Math.abs(lamp.z)).toBeGreaterThan(4);
    }
  });

  it('reads the deck height at the lamp\'s own distance along the road, not at the road\'s start', () => {
    const span: WorldRoad = {
      id: 'span', kind: 'primary', width: 10, structure: 'bridge', layer: 1,
      points: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
    };
    // A ramp climbing at a constant rate: each post should be higher than the last.
    const lights = generateStreetLights([span], [], { deckHeightAlong: (_road, along) => 2 + along * 0.03 });
    expect(lights.length).toBeGreaterThan(2);
    for (let index = 1; index < lights.length; index += 1) {
      expect(lights[index].y).toBeGreaterThan(lights[index - 1].y);
    }
    expect(lights[0].y).toBeCloseTo(2);
    expect(lights[1].y).toBeCloseTo(2 + LAMP_SPACING * 0.03);
  });

  it('is deterministic for the same input', () => {
    const road: WorldRoad = {
      id: 'road', kind: 'primary', width: 10,
      points: [{ x: -30, z: 12 }, { x: 40, z: -18 }, { x: 90, z: 5 }],
    };
    expect(generateStreetLights([road])).toEqual(generateStreetLights([road]));
  });

  it('carries lamps continuously across a multi-segment road without resetting at each vertex', () => {
    const road: WorldRoad = {
      id: 'bend', kind: 'residential', width: 6,
      points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 50, z: 50 }],
    };
    const lights = generateStreetLights([road]);
    // Total path length is 100m; spacing should hold across the corner, not restart.
    expect(lights.length).toBe(Math.floor(100 / LAMP_SPACING) + 1);
  });

  it('ignores degenerate roads', () => {
    expect(generateStreetLights([{ id: 'a', kind: 'residential', width: 6, points: [{ x: 0, z: 0 }] }])).toHaveLength(0);
    expect(generateStreetLights([{ id: 'b', kind: 'residential', width: 6, points: [] }])).toHaveLength(0);
  });
});
