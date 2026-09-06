import { describe, expect, it } from 'vitest';
import { createSpringSimulator, easeInOutSine, springStep } from '@/svartaksi/springSimulator';

describe('springStep', () => {
  it('accelerates towards the target and damps as it goes', () => {
    const first = springStep({ position: 0, velocity: 0 }, 1, 10, 0.5);
    expect(first.velocity).toBeCloseTo(0.05);
    expect(first.position).toBeCloseTo(0.05);

    const second = springStep(first, 1, 10, 0.5);
    expect(second.position).toBeGreaterThan(first.position);
  });

  it('settles at the target rather than oscillating around it', () => {
    let frame = { position: 0, velocity: 0 };
    for (let i = 0; i < 400; i += 1) frame = springStep(frame, 1, 10, 0.5);

    expect(frame.position).toBeCloseTo(1, 4);
    expect(Math.abs(frame.velocity)).toBeLessThan(1e-3);
  });
});

describe('createSpringSimulator', () => {
  it('integrates at its own rate, not the caller frame rate', () => {
    const sixty = createSpringSimulator();
    const thirty = createSpringSimulator();
    sixty.target = 1;
    thirty.target = 1;

    for (let i = 0; i < 60; i += 1) sixty.simulate(1 / 60);
    for (let i = 0; i < 30; i += 1) thirty.simulate(1 / 30);

    // One second of simulation either way. A variable-step integrator would have these
    // land in different places; this is exactly what the fixed step buys.
    expect(thirty.position).toBeCloseTo(sixty.position, 3);
  });

  it('starts from rest and approaches one without overshooting it', () => {
    const spring = createSpringSimulator();
    spring.target = 1;

    expect(spring.position).toBe(0);
    let previous = 0;
    for (let i = 0; i < 120; i += 1) {
      spring.simulate(1 / 60);
      expect(spring.position).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(spring.position).toBeLessThanOrEqual(1.0001);
      previous = spring.position;
    }
    expect(spring.position).toBeCloseTo(1, 2);
  });

  it('carries the leftover of a partial frame rather than dropping it', () => {
    const stepped = createSpringSimulator();
    const whole = createSpringSimulator();
    stepped.target = 1;
    whole.target = 1;

    for (let i = 0; i < 8; i += 1) stepped.simulate(1 / 480);
    whole.simulate(1 / 60);

    expect(stepped.position).toBeCloseTo(whole.position, 6);
  });
});

describe('easeInOutSine', () => {
  it('starts and ends at rest, and is symmetric about the middle', () => {
    expect(easeInOutSine(0)).toBeCloseTo(0);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5);
    expect(easeInOutSine(1)).toBeCloseTo(1);
    expect(easeInOutSine(0.25) + easeInOutSine(0.75)).toBeCloseTo(1);
  });
});
