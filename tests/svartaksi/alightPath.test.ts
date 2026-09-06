import { describe, expect, it } from 'vitest';
import { sampleAlightPath } from '../../src/svartaksi/alightPath';

describe('sampleAlightPath', () => {
  it('starts at the passenger seat and ends outside the kerb-side door', () => {
    expect(sampleAlightPath(0)).toEqual({ x: 0.88, z: -4.35 });
    expect(sampleAlightPath(1)).toEqual({ x: -2.4, z: -2.2 });
  });


  it('starts wherever the rider stood without snapping back to the seat', () => {
    const riderPosition = { x: -0.4, z: 1.25 };
    expect(sampleAlightPath(0, riderPosition)).toEqual(riderPosition);
    const firstStep = sampleAlightPath(0.001, riderPosition);
    expect(Math.hypot(firstStep.x - riderPosition.x, firstStep.z - riderPosition.z)).toBeLessThan(0.001);
    expect(sampleAlightPath(1, riderPosition)).toEqual({ x: -2.4, z: -2.2 });
  });

  it('passes through the aisle and doorway without overshooting', () => {
    const aisle = sampleAlightPath(0.35);
    const doorway = sampleAlightPath(0.72);
    expect(Math.abs(aisle.x)).toBeLessThan(0.35);
    expect(doorway.x).toBeLessThan(-1);
    expect(doorway.z).toBeGreaterThan(-3.1);
    expect(doorway.z).toBeLessThan(-1.3);
  });

  it('clamps progress and eases continuously', () => {
    expect(sampleAlightPath(-1)).toEqual(sampleAlightPath(0));
    expect(sampleAlightPath(2)).toEqual(sampleAlightPath(1));
    const before = sampleAlightPath(0.499);
    const after = sampleAlightPath(0.501);
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05);
  });
});
