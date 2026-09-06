import { describe, expect, it } from 'vitest';

import { resolveDoorStyle } from '../../src/svartaksi/doorStyle';
import type { WorldBuilding } from '../../src/world/types';

const building: WorldBuilding = {
  id: 'door-style',
  height: 12,
  properties: { building: 'apartments' },
  rings: [[
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 8 },
    { x: 0, z: 8 },
  ]],
};

describe('resolveDoorStyle', () => {
  it('uses explicit entrance tags ahead of the facade-family default', () => {
    expect(resolveDoorStyle({
      building,
      family: 'residential',
      entranceTags: { door: 'double' },
      seed: 0.3,
    }).kind).toBe('double');
    expect(resolveDoorStyle({
      building,
      family: 'residential',
      entranceTags: { access: 'private', entrance: 'service' },
      seed: 0.3,
    }).kind).toBe('service');
  });

  it.each([
    ['residential', 'solid'],
    ['store', 'shopfront'],
    ['industrial', 'service'],
  ] as const)('resolves %s facades to a suitable %s door', (family, kind) => {
    expect(resolveDoorStyle({
      building,
      family,
      entranceTags: {},
      seed: 0.1,
    }).kind).toBe(kind);
  });

  it('keeps numeric style values bounded and deterministic', () => {
    const input = {
      building,
      family: 'commercial' as const,
      entranceTags: { entrance: 'main', 'addr:housenumber': '12' },
      seed: 0.67,
    };
    const first = resolveDoorStyle(input);

    expect(resolveDoorStyle(input)).toEqual(first);
    expect(first.frameWidth).toBeGreaterThanOrEqual(0.04);
    expect(first.frameWidth).toBeLessThanOrEqual(0.18);
    expect([1, 2, 4]).toContain(first.panelCount);
    expect(first.glassRatio).toBeGreaterThanOrEqual(0);
    expect(first.glassRatio).toBeLessThanOrEqual(0.9);
    expect(first.color).toMatch(/^#[0-9A-F]{6}$/);
  });
});
