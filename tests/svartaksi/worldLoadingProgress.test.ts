import { describe, expect, it } from 'vitest';
import { worldBuildDetails } from '../../src/svartaksi/worldLoadingProgress';

describe('worldBuildDetails', () => {
  it('reports snapshot counts and completed work without calling estimates totals', () => {
    const details = worldBuildDetails({
      input: { buildings: 120, roads: 30, water: 2, parks: 7, objects: 16 },
      finishedSlices: 24, estimatedSlices: 20, elapsedMs: 1250, worstSliceMs: 8.24,
    });
    expect(details.join(' ')).toContain('120 buildings');
    expect(details.join(' ')).toContain('24 work slices completed (initial estimate: 20)');
    expect(details.join(' ')).toContain('1.3 s');
  });
});
