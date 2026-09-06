import { describe, expect, it } from 'vitest';
import { isPavementClear, isPointOnAnyRoad } from '../../src/world/roadClearance';
import type { WorldBuilding, WorldRoad } from '../../src/world/types';

describe('isPointOnAnyRoad', () => {
  it('rejects a point within a road\'s paved half-width plus margin', () => {
    const road: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
    expect(isPointOnAnyRoad(50, 3, [road], 0)).toBe(true);
    expect(isPointOnAnyRoad(50, 10, [road], 0)).toBe(false);
  });
});

describe('isPavementClear', () => {
  const road: WorldRoad = { id: 'a', kind: 'residential', width: 8, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] };
  const building: WorldBuilding = {
    id: 'b', height: 6, properties: {},
    rings: [[{ x: 20, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 30 }, { x: 20, z: 30 }]],
  };

  it('is clear when off the road, outside every building, and far from other placements', () => {
    expect(isPavementClear(50, 10, [road], 0)).toBe(true);
  });

  it('rejects a point on the road', () => {
    expect(isPavementClear(50, 3, [road], 0)).toBe(false);
  });

  it('rejects a point inside a building footprint', () => {
    expect(isPavementClear(25, 25, [road], 0, [building])).toBe(false);
    // Same point is fine when no buildings are passed at all.
    expect(isPavementClear(25, 25, [road], 0)).toBe(true);
  });

  it('rejects a point too close to another placement when spacing is requested', () => {
    const others = [{ x: 50, z: 12 }];
    expect(isPavementClear(50, 10, [road], 0, [], others, 5)).toBe(false);
    expect(isPavementClear(50, 10, [road], 0, [], others, 1)).toBe(true);
  });

  it('ignores spacing entirely when minSpacing is 0, regardless of other placements', () => {
    expect(isPavementClear(50, 10, [road], 0, [], [{ x: 50, z: 10 }], 0)).toBe(true);
  });
});
