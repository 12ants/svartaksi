import { describe, expect, it } from 'vitest';
import { createRenderBudget } from '../../src/world/renderBudget';

/** One frame's dt in seconds for a steady frame rate. */
const dtFor = (fps: number) => 1 / fps;

describe('createRenderBudget', () => {
  it('starts at full scale and stays there while frames run comfortably fast', () => {
    const budget = createRenderBudget();
    let changed = false;
    for (let i = 0; i < 200; i += 1) changed = budget.sample(dtFor(60)) || changed;
    expect(changed).toBe(false);
    expect(budget.getScale()).toBe(1);
  });

  it('steps the scale down after a sustained run of slow frames', () => {
    const budget = createRenderBudget();
    let changed = false;
    for (let i = 0; i < 60; i += 1) changed = budget.sample(dtFor(30)) || changed;
    expect(changed).toBe(true);
    expect(budget.getScale()).toBeLessThan(1);
  });

  it('does not react to a single stalled frame amid otherwise-fast frames', () => {
    const budget = createRenderBudget();
    for (let i = 0; i < 40; i += 1) budget.sample(dtFor(60));
    const changed = budget.sample(0.5); // one huge stall
    expect(changed).toBe(false);
    expect(budget.getScale()).toBe(1);
  });

  it('never steps below the configured floor no matter how long frames stay slow', () => {
    const budget = createRenderBudget();
    for (let i = 0; i < 2_000; i += 1) budget.sample(dtFor(15));
    expect(budget.getScale()).toBeGreaterThanOrEqual(0.35);
    expect(budget.getScale()).toBeLessThan(1);
  });

  it('steps back up once frame time recovers for long enough, but not immediately', () => {
    const budget = createRenderBudget();
    for (let i = 0; i < 60; i += 1) budget.sample(dtFor(30));
    const loweredScale = budget.getScale();
    expect(loweredScale).toBeLessThan(1);

    // Not yet — the rolling average is still dominated by the recent slow frames, and
    // even once it clears the "fast" threshold, the streak hasn't reached STEP_UP_AFTER.
    for (let i = 0; i < 60; i += 1) budget.sample(dtFor(60));
    expect(budget.getScale()).toBe(loweredScale);

    for (let i = 0; i < 400; i += 1) budget.sample(dtFor(60));
    expect(budget.getScale()).toBeGreaterThan(loweredScale);
  });

  it('recovers to exactly full scale (1), the same ceiling as an unscaled quality tier', () => {
    const budget = createRenderBudget();
    for (let i = 0; i < 60; i += 1) budget.sample(dtFor(20));
    for (let i = 0; i < 2_000; i += 1) budget.sample(dtFor(120));
    expect(budget.getScale()).toBe(1);
  });
});
