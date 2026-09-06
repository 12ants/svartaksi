import { describe, expect, it } from 'vitest';
import { createPreviewWorld, normalizeOsmElements } from '../../src/world/normalize';

const origin = { lng: 18.0686, lat: 59.3293 };

describe('normalized worlds', () => {
  it('creates a complete deterministic preview for either source', () => {
    const first = createPreviewWorld('maplibre');
    const second = createPreviewWorld('maplibre');
    expect(first).toEqual(second);
    expect(first.roads.length).toBeGreaterThan(5);
    expect(first.buildings.length).toBeGreaterThan(20);
    expect(first.water.length).toBeGreaterThan(0);
  });

  it('normalizes Overpass ways with geometry', () => {
    const data = normalizeOsmElements([
      { type: 'way', id: 1, tags: { highway: 'residential', name: 'Testgatan' }, geometry: [
        { lon: 18.068, lat: 59.329 }, { lon: 18.07, lat: 59.33 },
      ] },
      { type: 'way', id: 2, tags: { building: 'commercial', 'building:use': 'commercial', 'building:levels': '4', 'building:colour': '#c07050' }, geometry: [
        { lon: 18.068, lat: 59.329 }, { lon: 18.069, lat: 59.329 },
        { lon: 18.069, lat: 59.33 }, { lon: 18.068, lat: 59.329 },
      ] },
      { type: 'way', id: 3, tags: { landuse: 'meadow', name: 'Test Meadow' }, geometry: [
        { lon: 18.067, lat: 59.329 }, { lon: 18.068, lat: 59.329 },
        { lon: 18.068, lat: 59.33 }, { lon: 18.067, lat: 59.329 },
      ] },
      { type: 'node', id: 4, tags: { amenity: 'bench', material: 'wood' }, lon: 18.0685, lat: 59.3295 },
    ], origin);
    expect(data.roads[0]).toMatchObject({ kind: 'residential' });
    expect(data.buildings[0].height).toBe(12);
    expect(data.buildings[0].properties).toEqual(expect.objectContaining({
      type: 'commercial',
      class: 'commercial',
      building: 'commercial',
      'building:levels': '4',
      'building:colour': '#c07050',
    }));
    expect(data.labels[0].text).toBe('Testgatan');
    expect(data.parks[0]).toMatchObject({ kind: 'meadow' });
    expect(data.objects[0]).toMatchObject({ kind: 'bench', properties: { material: 'wood' } });
  });

  it('marks shops and nightlife as storefronts, which is what earns a neon sign', () => {
    const data = normalizeOsmElements([
      { type: 'node', id: 10, tags: { shop: 'bakery', name: 'Brödboden' }, lon: 18.0685, lat: 59.3295 },
      { type: 'node', id: 11, tags: { amenity: 'bar', name: 'Baren' }, lon: 18.0686, lat: 59.3295 },
      // A place, not a frontage: no sign over the school gates.
      { type: 'node', id: 12, tags: { amenity: 'school', name: 'Skolan' }, lon: 18.0687, lat: 59.3295 },
      { type: 'node', id: 13, tags: { amenity: 'bench' }, lon: 18.0688, lat: 59.3295 },
    ], origin);

    const kinds = data.objects.map((object) => object.kind);
    expect(kinds).toEqual(['storefront', 'storefront', 'bench']);
  });
});
