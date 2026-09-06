import { describe, expect, it } from 'vitest';
import { clipBuildingsToArea } from '../../../src/world/providers/maplibreProvider';
import type { WorldBuilding } from '../../../src/world/types';

const buildingAt = (id: string, x: number, z: number): WorldBuilding => ({
  id,
  height: 10,
  rings: [[{ x: x - 1, z: z - 1 }, { x: x + 1, z: z - 1 }, { x: x + 1, z: z + 1 }, { x: x - 1, z: z + 1 }]],
  properties: {},
});

describe('clipBuildingsToArea', () => {
  it('keeps a building within radius of the centre, and drops one outside it, when there is no corridor', () => {
    const buildings = [buildingAt('near', 3, 4), buildingAt('far', 100, 0)];
    const kept = clipBuildingsToArea(buildings, { center: { x: 0, z: 0 }, corridor: null, radiusMeters: 5 });
    expect(kept.map((b) => b.id)).toEqual(['near']);
  });

  it('keeps a building near the corridor line even far from the centre point, when a corridor is given', () => {
    // Far from `center` (which sits at the corridor's midpoint here) along the route,
    // but right next to the line itself — a plain centre-radius clip would drop this.
    const buildings = [buildingAt('on-route', 90, 2)];
    const kept = clipBuildingsToArea(buildings, {
      center: { x: 50, z: 0 },
      corridor: { from: { x: 0, z: 0 }, to: { x: 100, z: 0 } },
      radiusMeters: 5,
    });
    expect(kept.map((b) => b.id)).toEqual(['on-route']);
  });

  it('drops a building off the corridor line even though it is close to the centre point', () => {
    const buildings = [buildingAt('off-route', 50, 20)];
    const kept = clipBuildingsToArea(buildings, {
      center: { x: 50, z: 0 },
      corridor: { from: { x: 0, z: 0 }, to: { x: 100, z: 0 } },
      radiusMeters: 5,
    });
    expect(kept).toHaveLength(0);
  });
});
