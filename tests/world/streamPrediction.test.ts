import { describe, expect, it } from 'vitest';

import { predictStreamCenter } from '../../src/world/streamPrediction';

describe('predictStreamCenter', () => {
  it('projects the active position forward along its heading', () => {
    expect(predictStreamCenter({ x: 10, z: 20 }, Math.PI / 2, 300)).toEqual({
      x: 310,
      z: 20,
    });
  });

  it('clamps look-ahead distance to a conservative bounded range', () => {
    expect(predictStreamCenter({ x: 0, z: 0 }, 0, 10).z).toBe(180);
    expect(predictStreamCenter({ x: 0, z: 0 }, 0, 2_000).z).toBe(520);
  });

  it('returns the current position for malformed input', () => {
    expect(predictStreamCenter({ x: 5, z: 7 }, Number.NaN)).toEqual({ x: 5, z: 7 });
  });
});
