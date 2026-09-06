import { describe, expect, it } from 'vitest';

import type { FacadeProfile } from '../../src/svartaksi/buildingFacade';
import { solveFacadeLayout } from '../../src/svartaksi/facadeLayout';

const profile: FacadeProfile = {
  firstFloorHeight: 4,
  roofPadding: 0.8,
  sidePadding: 1.2,
  windowWidth: 0.9,
  windowHeight: 1.5,
  windowSpacingX: 1.8,
  windowSpacingY: 3,
  wallColor: '#000000',
  windowColor: '#ffffff',
  doorColor: '#9A603F',
  litRatio: 0.5,
};

describe('solveFacadeLayout', () => {
  it('centers complete columns and rows within the corner, ground, and roof reserves', () => {
    const layout = solveFacadeLayout(12, 16, profile);

    expect(layout).not.toBeNull();
    expect(layout?.columns).toBe(5);
    expect(layout?.rows).toBe(4);
    expect(layout?.startX).toBeCloseTo(1.95);
    expect(layout?.endX).toBeCloseTo(10.05);
    expect(layout?.startY).toBeCloseTo(4.35);
    expect(layout?.endY).toBeCloseTo(14.85);
    expect(layout?.startX).toBeCloseTo(12 - layout!.endX);
    expect(layout!.startY - profile.firstFloorHeight).toBeCloseTo(
      16 - profile.roofPadding - layout!.endY,
    );
  });

  it('never creates a partial module at a wall boundary', () => {
    for (let width = 0.5; width <= 100; width += 0.5) {
      for (let height = 1; height <= 80; height += 1) {
        const layout = solveFacadeLayout(width, height, profile);
        if (!layout) continue;

        const occupiedWidth = (layout.columns - 1) * profile.windowSpacingX + profile.windowWidth;
        const occupiedHeight = (layout.rows - 1) * profile.windowSpacingY + profile.windowHeight;
        const respectsBounds =
          layout.startX >= profile.sidePadding &&
          layout.endX <= width - profile.sidePadding + 1e-9 &&
          layout.startY >= profile.firstFloorHeight &&
          layout.endY <= height - profile.roofPadding + 1e-9;
        const usesCompleteModules =
          Math.abs(layout.endX - layout.startX - occupiedWidth) <= 1e-9 &&
          Math.abs(layout.endY - layout.startY - occupiedHeight) <= 1e-9;

        if (!respectsBounds || !usesCompleteModules) {
          throw new Error(
            `Invalid facade layout at ${width}m × ${height}m: ${JSON.stringify(layout)}`,
          );
        }
      }
    }
  });

  it('rejects walls without room for one complete window', () => {
    expect(solveFacadeLayout(3, 16, profile)).toBeNull();
    expect(solveFacadeLayout(12, 6, profile)).toBeNull();
  });

  it('rejects invalid dimensions and profiles', () => {
    expect(solveFacadeLayout(Number.NaN, 16, profile)).toBeNull();
    expect(solveFacadeLayout(12, Number.POSITIVE_INFINITY, profile)).toBeNull();
    expect(solveFacadeLayout(12, 16, { ...profile, windowSpacingX: 0 })).toBeNull();
    expect(solveFacadeLayout(12, 16, { ...profile, litRatio: 2 })).toBeNull();
  });
});
