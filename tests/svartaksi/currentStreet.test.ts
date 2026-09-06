import { describe, expect, it } from 'vitest';
import { resolveCurrentStreet } from '../../src/svartaksi/currentStreet';
import type { WorldLabel, WorldRoad } from '../../src/world/types';

const roads: WorldRoad[] = [{
  id: 'road',
  kind: 'residential',
  width: 7,
  points: [{ x: -100, z: 0 }, { x: 100, z: 0 }],
}];

const labels: WorldLabel[] = [{
  id: 'street',
  text: 'Strandvägen',
  point: { x: 8, z: 2 },
  category: 'street',
}];

describe('resolveCurrentStreet', () => {
  it('associates the nearest street label with a nearby road', () => {
    expect(resolveCurrentStreet({ x: 0, z: 3 }, roads, labels)).toBe('Strandvägen');
    expect(resolveCurrentStreet(
      { x: 0, z: 3 },
      roads,
      [{ ...labels[0], category: 'Road' }],
    )).toBe('Strandvägen');
  });

  it('ignores non-street labels and distant roads', () => {
    expect(resolveCurrentStreet(
      { x: 0, z: 3 },
      roads,
      [{ ...labels[0], category: 'place' }],
    )).toBeNull();
    expect(resolveCurrentStreet({ x: 0, z: 50 }, roads, labels, 20)).toBeNull();
  });

  it('falls back to the nearest street label when none belongs to the road underfoot', () => {
    // The point is on an unnamed stub; the named street it plainly joins is a junction
    // away, too far from the stub to be associated with it directly.
    const stub: WorldRoad = {
      id: 'stub', kind: 'service', width: 5,
      points: [{ x: 0, z: 0 }, { x: 0, z: 30 }],
    };
    const nearbyLabel: WorldLabel[] = [{
      id: 'street', text: 'Krukmakargatan', point: { x: 55, z: 5 }, category: 'street',
    }];

    expect(resolveCurrentStreet({ x: 0, z: 10 }, [stub], nearbyLabel)).toBe('Krukmakargatan');
    // Still bounded — a label a block away is somebody else's street.
    expect(resolveCurrentStreet(
      { x: 0, z: 10 },
      [stub],
      [{ ...nearbyLabel[0], point: { x: 400, z: 5 } }],
    )).toBeNull();
  });

  it('caps display-safe names and handles empty road geometry', () => {
    const long = 'A'.repeat(40);
    expect(resolveCurrentStreet(
      { x: 0, z: 0 },
      roads,
      [{ ...labels[0], text: long }],
    )).toBe('A'.repeat(24));
    expect(resolveCurrentStreet({ x: 0, z: 0 }, [{ ...roads[0], points: [] }], labels)).toBeNull();
  });
});
