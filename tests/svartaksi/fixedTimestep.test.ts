import { describe, expect, it } from 'vitest';
import { accumulateFixedSteps } from '../../src/svartaksi/fixedTimestep';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 8;

describe('accumulateFixedSteps', () => {
  it('produces one step for a delta matching the fixed step exactly', () => {
    const { steps, accumulator } = accumulateFixedSteps(FIXED_DT, 0, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(1);
    expect(accumulator).toBeCloseTo(0, 9);
  });

  it('carries a sub-step delta into the accumulator rather than stepping early', () => {
    const half = FIXED_DT / 2;
    const { steps, accumulator } = accumulateFixedSteps(half, 0, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(0);
    expect(accumulator).toBeCloseTo(half, 9);
  });

  it('accumulates across calls until a step is due, at a high refresh rate', () => {
    const eighthOfFixed = FIXED_DT / 8;
    let accumulator = 0;
    let totalSteps = 0;
    for (let frame = 0; frame < 8; frame += 1) {
      const result = accumulateFixedSteps(eighthOfFixed, accumulator, FIXED_DT, MAX_STEPS);
      accumulator = result.accumulator;
      totalSteps += result.steps;
    }
    expect(totalSteps).toBe(1);
  });

  it('runs multiple catch-up steps for a slow frame, consuming almost all the elapsed time', () => {
    const slowFrame = FIXED_DT * 4; // ~15fps
    const { steps, accumulator } = accumulateFixedSteps(slowFrame, 0, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(4);
    expect(accumulator).toBeCloseTo(0, 9);
  });

  it('bounds catch-up at maxSteps and drops the remainder instead of owing it forward', () => {
    const hugeStall = 5; // tab was backgrounded for 5 real seconds
    const { steps, accumulator } = accumulateFixedSteps(hugeStall, 0, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(MAX_STEPS);
    expect(accumulator).toBe(0);
  });

  it('never produces a negative accumulator or step count for a zero delta', () => {
    const { steps, accumulator } = accumulateFixedSteps(0, 0, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(0);
    expect(accumulator).toBe(0);
  });

  it('treats a negative delta as zero rather than eating into the accumulator', () => {
    const { steps, accumulator } = accumulateFixedSteps(-1, FIXED_DT / 2, FIXED_DT, MAX_STEPS);
    expect(steps).toBe(0);
    expect(accumulator).toBeCloseTo(FIXED_DT / 2, 9);
  });
});
