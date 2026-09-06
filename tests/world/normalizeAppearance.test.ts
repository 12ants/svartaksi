import { describe, expect, it } from 'vitest';
import { normalizeBuildingAppearance } from '../../src/world/normalizeAppearance';

describe('building appearance normalization', () => {
  it('normalizes useful OSM appearance tags', () => {
    expect(normalizeBuildingAppearance({
      building: ' Apartments ',
      'building:use': 'Residential',
      'building:colour': '#aabbcc',
      'roof:color': 'Red',
      'roof:shape': 'Flat',
      'building:levels': '4',
      'addr:housenumber': '12A',
    })).toEqual({
      buildingKind: 'apartments',
      buildingUse: 'residential',
      wallColor: '#aabbcc',
      roofShape: 'flat',
      roofColor: 'red',
      levels: 4,
      houseNumber: '12a',
    });
  });

  it('ignores invalid colors and levels', () => {
    expect(normalizeBuildingAppearance({
      'building:colour': 'url(evil)',
      'building:levels': '-2',
    })).toEqual({});
  });
});
