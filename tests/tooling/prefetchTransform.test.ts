import { describe, expect, it } from 'vitest';
import { roundWorldData, slugify } from '../../scripts/lib/prefetchTransform.mjs';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Krukmakargatan')).toBe('krukmakargatan');
    expect(slugify('Gamla Stan')).toBe('gamla-stan');
    expect(slugify('Sergels Torg')).toBe('sergels-torg');
  });

  it('strips characters outside [a-z0-9-]', () => {
    expect(slugify("Söder Malm!")).toBe('s-der-malm');
  });
});

describe('roundWorldData', () => {
  const sample = () => ({
    source: 'maplibre',
    roads: [{ id: 'r1', kind: 'street', width: 9, points: [{ x: 1.2345, z: -6.7891 }] }],
    buildings: [{ id: 'b1', height: 12, rings: [[{ x: 3.14159, z: 2.71828 }]], properties: {} }],
    water: [{ id: 'w1', kind: 'water', rings: [[{ x: 0.005, z: 0.004 }]] }],
    parks: [],
    labels: [{ id: 'l1', text: 'Main St', point: { x: 1.999, z: 0 } }],
    objects: [{ id: 'o1', kind: 'entrance', point: { x: -0.001, z: 0.006 }, properties: {} }],
  });

  it('rounds every LocalPoint to the nearest precision, at 1cm', () => {
    const rounded = roundWorldData(sample(), 1);
    expect(rounded.roads[0].points[0]).toEqual({ x: 1.23, z: -6.79 });
    expect(rounded.buildings[0].rings[0][0]).toEqual({ x: 3.14, z: 2.72 });
    expect(rounded.water[0].rings[0][0]).toEqual({ x: 0, z: 0 });
    expect(rounded.labels[0].point).toEqual({ x: 2, z: 0 });
    expect(rounded.objects[0].point).toEqual({ x: 0, z: 0.01 });
  });

  it('rounds to a coarser grid at 100cm without dropping any array entries', () => {
    const rounded = roundWorldData(sample(), 100);
    expect(rounded.roads[0].points[0]).toEqual({ x: 1, z: -7 });
    expect(rounded.roads).toHaveLength(1);
    expect(rounded.buildings).toHaveLength(1);
  });

  it('is structurally identical apart from the numbers', () => {
    const original = sample();
    const rounded = roundWorldData(original, 1);
    expect(rounded.roads[0].id).toBe('r1');
    expect(rounded.roads[0].kind).toBe('street');
    expect(rounded.roads[0].width).toBe(9);
    expect(rounded.buildings[0].properties).toEqual({});
    expect(Object.keys(rounded)).toEqual(Object.keys(original));
  });
});
