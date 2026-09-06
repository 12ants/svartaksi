import { describe, expect, it } from 'vitest';
import { chooseRandomSpawn, isSafeSpawnPoint, pointInRing } from '../../src/svartaksi/randomSpawn';
import type { WorldData } from '../../src/world/types';

const square = (min: number, max: number) => [
  { x: min, z: min }, { x: max, z: min }, { x: max, z: max }, { x: min, z: max },
];

function world(overrides: Partial<WorldData> = {}): WorldData {
  return {
    source: 'maplibre', roads: [], buildings: [], water: [], labels: [], objects: [],
    parks: [{ id: 'park', kind: 'park', rings: [square(0, 20)] }],
    ...overrides,
  };
}

describe('random safe spawn', () => {
  it('recognizes points inside and outside a ring', () => {
    expect(pointInRing({ x: 5, z: 5 }, square(0, 10))).toBe(true);
    expect(pointInRing({ x: 15, z: 5 }, square(0, 10))).toBe(false);
  });

  it('chooses a deterministic point inside an open field', () => {
    const spawn = chooseRandomSpawn(world(), () => 0.25);
    expect(spawn).not.toBeNull();
    expect(spawn?.sourceAreaId).toBe('park');
    expect(pointInRing(spawn!.local, square(0, 20))).toBe(true);
  });

  it('avoids building and water interiors', () => {
    const data = world({
      buildings: [{ id: 'building', height: 8, properties: {}, rings: [square(8, 12)] }],
      water: [{ id: 'water', kind: 'water', rings: [square(0, 6)] }],
    });
    const spawn = chooseRandomSpawn(data, () => 0.9);
    expect(spawn).not.toBeNull();
    expect(isSafeSpawnPoint(spawn!.local, data)).toBe(true);
  });

  it('returns null when there is no supported open field', () => {
    expect(chooseRandomSpawn(world({ parks: [{ id: 'yard', kind: 'private', rings: [square(0, 20)] }] }))).toBeNull();
  });
});
