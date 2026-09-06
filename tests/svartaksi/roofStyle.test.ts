import { describe, expect, it } from 'vitest';
import { resolveRoofStyle } from '../../src/svartaksi/roofStyle';

const building = {
  id: 'roofed', height: 12, properties: {},
  rings: [[{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }]],
};

describe('roof style', () => {
  it('prefers explicit roof metadata without generating rooftop equipment settings', () => {
    const style = resolveRoofStyle({
      ...building,
      appearance: { roofColor: '#aabbcc', roofMaterial: 'metal', roofShape: 'flat' },
    });
    expect(style.color).toBe('#aabbcc');
    expect(style.roughness).toBeLessThan(0.8);
    expect(style).not.toHaveProperty('equipmentChance');
    expect(style.capLift).toBeGreaterThanOrEqual(0.035);
  });

  it('is stable for the same building', () => {
    expect(resolveRoofStyle(building)).toEqual(resolveRoofStyle(building));
  });
});
