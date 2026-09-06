import { describe, expect, it } from 'vitest';
import {
  advanceBusSuspension,
  advanceSpring,
  createBusSuspension,
  createSpring,
  wheelTravel,
  BUS_SUSPENSION_CONFIG,
} from '../../src/svartaksi/busSuspension';

function settle(target: number, ticks = 600) {
  let state = createSpring();
  for (let step = 0; step < ticks; step += 1) {
    state = advanceSpring(state, target, 42, 9.5, 1 / 60);
  }
  return state;
}

describe('advanceSpring', () => {
  it('converges on its target and stops there', () => {
    const state = settle(0.4);
    expect(state.value).toBeCloseTo(0.4, 3);
    expect(Math.abs(state.velocity)).toBeLessThan(0.01);
  });

  it('does not arrive instantly', () => {
    const state = advanceSpring(createSpring(), 1, 42, 9.5, 1 / 60);
    expect(state.value).toBeGreaterThan(0);
    expect(state.value).toBeLessThan(0.05);
  });

  it('loses energy rather than gaining it', () => {
    let state = { value: 1, velocity: 0 };
    let peak = 0;
    for (let step = 0; step < 600; step += 1) {
      state = advanceSpring(state, 0, 42, 9.5, 1 / 60);
      peak = Math.max(peak, Math.abs(state.value));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(Math.abs(state.value)).toBeLessThan(0.01);
  });

  it('is stable at the tick rate the simulation runs at', () => {
    let state = { value: 0, velocity: 0 };
    for (let step = 0; step < 4_000; step += 1) {
      state = advanceSpring(state, step % 120 < 60 ? 0.2 : -0.2, 42, 9.5, 1 / 60);
    }
    expect(Number.isFinite(state.value)).toBe(true);
    expect(Math.abs(state.value)).toBeLessThan(1);
  });
});

describe('advanceBusSuspension', () => {
  const level = { frontLeft: 0, frontRight: 0, rearLeft: 0, rearRight: 0 };

  function settleOn(corners: typeof level, ticks = 900) {
    let state = createBusSuspension();
    for (let step = 0; step < ticks; step += 1) state = advanceBusSuspension(state, corners, 1 / 60);
    return state;
  }

  it('sits level and at zero on flat ground', () => {
    const state = settleOn(level);
    expect(state.heave.value).toBeCloseTo(0, 4);
    expect(state.pitch.value).toBeCloseTo(0, 4);
    expect(state.roll.value).toBeCloseTo(0, 4);
  });

  it('rises to meet ground that has risen under all four corners', () => {
    const state = settleOn({ frontLeft: 1.2, frontRight: 1.2, rearLeft: 1.2, rearRight: 1.2 });
    expect(state.heave.value).toBeCloseTo(1.2, 3);
  });

  it('lifts its nose when the front wheels climb', () => {
    const state = settleOn({ frontLeft: 0.5, frontRight: 0.5, rearLeft: 0, rearRight: 0 });
    // Rotation about +x lowers the +z end, so a raised nose is a negative pitch.
    expect(state.pitch.value).toBeLessThan(0);
    expect(state.pitch.value).toBeCloseTo(-0.5 / BUS_SUSPENSION_CONFIG.wheelbase, 3);
  });

  it('rolls towards the lower side', () => {
    const state = settleOn({ frontLeft: 0.3, frontRight: 0, rearLeft: 0.3, rearRight: 0 });
    // Positive roll lifts the +x (left) side, which is the one on higher ground.
    expect(state.roll.value).toBeGreaterThan(0);
  });

  it('takes time to respond to a step rather than snapping to it', () => {
    let state = createBusSuspension();
    const stepped = { frontLeft: 0.4, frontRight: 0.4, rearLeft: 0.4, rearRight: 0.4 };
    for (let tick = 0; tick < 3; tick += 1) state = advanceBusSuspension(state, stepped, 1 / 60);
    expect(state.heave.value).toBeLessThan(0.1);
  });
});

describe('wheelTravel', () => {
  it('is zero when the body is already where the ground is', () => {
    const state = createBusSuspension();
    expect(wheelTravel(state, 1, 3, 0)).toBeCloseTo(0, 6);
  });

  it('extends the wheel towards ground the body has not reached yet', () => {
    const state = createBusSuspension();
    expect(wheelTravel(state, 0, 0, 0.05)).toBeCloseTo(0.05, 6);
  });

  it('accounts for where the wheel sits under a tilted body', () => {
    const state = createBusSuspension();
    state.pitch.value = 0.05;
    // Positive pitch lowers the front of the body, so a front wheel on level ground has
    // to travel *up* into its arch to stay put.
    expect(wheelTravel(state, 0, 3.75, 0)).toBeGreaterThan(0);
    expect(wheelTravel(state, 0, -3.65, 0)).toBeLessThan(0);
  });

  it('bottoms out at the limit of the arch', () => {
    const state = createBusSuspension();
    expect(wheelTravel(state, 0, 0, 5, 0.13)).toBeCloseTo(0.13, 6);
    expect(wheelTravel(state, 0, 0, -5, 0.13)).toBeCloseTo(-0.13, 6);
  });
});
