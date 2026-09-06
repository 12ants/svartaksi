import { describe, expect, it } from 'vitest';
import { rankNearbyPlaces } from '../../src/svartaksi/nearbyPlaces';
import type { WorldLabel } from '../../src/world/types';

/** Facing due north in this renderer's convention: forward = (sin h, 0, cos h). */
const NORTH = 0;

const label = (id: string, x: number, z: number, overrides: Partial<WorldLabel> = {}): WorldLabel => ({
  id, text: id, point: { x, z }, category: 'Place', ...overrides,
});

describe('rankNearbyPlaces', () => {
  it('classifies a label straight ahead as ahead', () => {
    const [item] = rankNearbyPlaces([label('a', 0, 100)], 0, 0, NORTH);
    expect(item.direction).toBe('ahead');
    expect(item.distance).toBe(100);
  });

  it('classifies a label behind as behind', () => {
    const [item] = rankNearbyPlaces([label('a', 0, -100)], 0, 0, NORTH);
    expect(item.direction).toBe('behind');
  });

  it('classifies a label ahead and to the left as ahead-left', () => {
    const [item] = rankNearbyPlaces([label('a', 50, 90)], 0, 0, NORTH);
    expect(item.direction).toBe('ahead-left');
  });

  it('classifies a label ahead and to the right as ahead-right', () => {
    const [item] = rankNearbyPlaces([label('a', -50, 90)], 0, 0, NORTH);
    expect(item.direction).toBe('ahead-right');
  });

  it('classifies a label directly abeam as left or right', () => {
    const [leftItem] = rankNearbyPlaces([label('a', 100, 0)], 0, 0, NORTH);
    expect(leftItem.direction).toBe('left');
    const [rightItem] = rankNearbyPlaces([label('a', -100, 0)], 0, 0, NORTH);
    expect(rightItem.direction).toBe('right');
  });

  it('measures distance from the given origin, not the world origin', () => {
    const [item] = rankNearbyPlaces([label('a', 120, 100)], 120, 0, NORTH);
    expect(item.distance).toBe(100);
  });

  it('drops labels beyond 500m', () => {
    const result = rankNearbyPlaces([label('near', 0, 400), label('far', 0, 600)], 0, 0, NORTH);
    expect(result.map((item) => item.name)).toEqual(['near']);
  });

  it('ranks a label ahead above an equally-distant label behind', () => {
    const result = rankNearbyPlaces([label('behind', 0, -200), label('ahead', 0, 200)], 0, 0, NORTH);
    expect(result.map((item) => item.name)).toEqual(['ahead', 'behind']);
  });

  it('caps the result at 16 items', () => {
    const labels = Array.from({ length: 20 }, (_, index) => label(`p${index}`, index, 10));
    expect(rankNearbyPlaces(labels, 0, 0, NORTH)).toHaveLength(16);
  });

  it('falls back to category "Place" and carries the detail through', () => {
    const [item] = rankNearbyPlaces([label('a', 0, 50, { category: undefined, detail: 'a bench' })], 0, 0, NORTH);
    expect(item.category).toBe('Place');
    expect(item.detail).toBe('a bench');
  });
});
