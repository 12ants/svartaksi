import { describe, expect, it } from 'vitest';
import { generateStreetFurniture, MAX_GENERATED_FURNITURE } from '../../src/world/streetFurniture';
import type { WorldData } from '../../src/world/types';

const ring = (x: number, z: number, size: number) => [
  { x, z }, { x: x + size, z }, { x: x + size, z: z + size }, { x, z: z + size }, { x, z },
];
const fixture = (): WorldData => ({
  source: 'maplibre', buildings: [], water: [], labels: [], objects: [],
  parks: [{ id: 'park', kind: 'park', rings: [ring(0, 30, 40)] }],
  roads: [{ id: 'street', kind: 'residential', width: 6, points: [{ x: 0, z: 0 }, { x: 500, z: 0 }] }],
});
function generate(data: WorldData, radius = 600) {
  const iterator = generateStreetFurniture(data, { x: 0, z: 0 }, radius);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}
describe('street furniture placement', () => {
  it('fills sparse map data with stable bins, benches and park fountains', () => {
    const data = fixture();
    const objects = generate(data);
    expect(new Set(objects.map((object) => object.kind))).toEqual(new Set(['fountain', 'bench', 'waste_basket']));
    expect(generate(data)).toEqual(objects);
    expect(data.objects).toEqual([]);
    expect(new Set(objects.map((object) => object.id)).size).toBe(objects.length);
  });
  it('keeps out of water, buildings, park holes and mapped furniture', () => {
    const data = fixture();
    data.water = [{ id: 'lake', kind: 'water', rings: [ring(-20, -20, 600)] }];
    expect(generate(data)).toEqual([]);
    data.water = [];
    data.buildings = [{ id: 'block', height: 10, properties: {}, rings: [ring(-20, -20, 600)] }];
    expect(generate(data)).toEqual([]);
    data.buildings = [];
    data.parks[0].rings.push(ring(15, 45, 10));
    expect(generate(data).some((object) => object.kind === 'fountain')).toBe(false);
    data.objects = generate(data);
    expect(generate(data)).toEqual([]);
  });
  it('avoids bridges and tunnels and respects the draw radius and cap', () => {
    const data = fixture();
    data.parks = [];
    for (const structure of ['bridge', 'tunnel'] as const) {
      data.roads[0].structure = structure;
      expect(generate(data)).toEqual([]);
    }
    data.roads[0].structure = 'ground';
    expect(generate(data, 20)).toEqual([]);
    data.roads[0].points[1].x = 100000;
    expect(generate(data, 100000)).toHaveLength(MAX_GENERATED_FURNITURE);
  });
});
