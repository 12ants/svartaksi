import { describe, expect, it } from 'vitest';

import { siteStable, STABLE_OSM_MATCH_RANGE_METERS } from '../../src/world/procedural/siteStable';
import type { WorldArea, WorldObject } from '../../src/world/types';

function square(id: string, kind: string, cx: number, cz: number, half: number): WorldArea {
  return {
    id,
    kind,
    rings: [[
      { x: cx - half, z: cz - half },
      { x: cx + half, z: cz - half },
      { x: cx + half, z: cz + half },
      { x: cx - half, z: cz + half },
    ]],
  };
}

describe('siteStable', () => {
  it('picks an OSM-tagged stable candidate within range over the procedural fallback', () => {
    const objects: WorldObject[] = [
      { id: 'poi-1', kind: 'poi', point: { x: 40, z: -20 }, properties: { amenity: 'stable' } },
    ];
    const areas: WorldArea[] = [square('forest-1', 'forest', 200, 200, 80)];
    const result = siteStable({ objects, areas }, 1);
    expect(result.source).toBe('osm');
    expect(result.x).toBe(40);
    expect(result.z).toBe(-20);
    expect(result.justification).toMatch(/osm/i);
  });

  it('recognizes the plausible OSM stable tag vocabulary', () => {
    const tagCases: Array<Record<string, unknown>> = [
      { amenity: 'stable' },
      { building: 'stable' },
      { leisure: 'horse_riding' },
      { sport: 'equestrian' },
    ];
    for (const properties of tagCases) {
      const objects: WorldObject[] = [{ id: 'poi', kind: 'poi', point: { x: 5, z: 5 }, properties }];
      const result = siteStable({ objects, areas: [] }, 1);
      expect(result.source).toBe('osm');
    }
  });

  it('ignores an OSM candidate outside the match range and falls back to procedural', () => {
    const objects: WorldObject[] = [
      { id: 'poi-1', kind: 'poi', point: { x: STABLE_OSM_MATCH_RANGE_METERS + 500, z: 0 }, properties: { amenity: 'stable' } },
    ];
    const areas: WorldArea[] = [square('forest-1', 'forest', 0, 0, 100)];
    const result = siteStable({ objects, areas }, 1);
    expect(result.source).toBe('procedural');
  });

  it('falls back to a forest clearing when no OSM candidate exists', () => {
    const areas: WorldArea[] = [square('forest-1', 'forest', 0, 0, 100)];
    const result = siteStable({ objects: [], areas }, 1);
    expect(result.source).toBe('procedural');
    expect(result.justification).toMatch(/procedur|forest|clearing/i);
    // Placement must land inside the forest polygon that supplied it.
    expect(result.x).toBeGreaterThanOrEqual(-100);
    expect(result.x).toBeLessThanOrEqual(100);
    expect(result.z).toBeGreaterThanOrEqual(-100);
    expect(result.z).toBeLessThanOrEqual(100);
  });

  it('prefers forest/wood areas over other landuse for the procedural fallback', () => {
    const areas: WorldArea[] = [
      square('park-1', 'park', 0, 0, 100),
      square('wood-1', 'wood', 500, 500, 100),
    ];
    const result = siteStable({ objects: [], areas }, 1);
    expect(result.source).toBe('procedural');
    expect(Math.abs(result.x - 500)).toBeLessThanOrEqual(100);
    expect(Math.abs(result.z - 500)).toBeLessThanOrEqual(100);
  });

  it('is deterministic per seed', () => {
    const areas: WorldArea[] = [square('forest-1', 'forest', 0, 0, 100)];
    const a = siteStable({ objects: [], areas }, 42);
    const b = siteStable({ objects: [], areas }, 42);
    expect(a).toEqual(b);
  });

  it('produces a different placement for a different seed', () => {
    const areas: WorldArea[] = [square('forest-1', 'forest', 0, 0, 300)];
    const a = siteStable({ objects: [], areas }, 1);
    const b = siteStable({ objects: [], areas }, 2);
    expect(a.x !== b.x || a.z !== b.z).toBe(true);
  });

  it('throws a clear error when no OSM candidate and no forest/wood area exists', () => {
    const areas: WorldArea[] = [square('park-1', 'park', 0, 0, 100)];
    expect(() => siteStable({ objects: [], areas }, 1)).toThrow(/forest|wood|no.*area/i);
  });
});
