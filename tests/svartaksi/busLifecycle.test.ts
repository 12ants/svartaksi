import { describe, expect, it } from 'vitest';
import {
  advanceBusLifecycle,
  canRelocateWorld,
  createBusLifecycle,
  type BusLifecycleState,
} from '../../src/svartaksi/busLifecycle';

function advance(
  state: BusLifecycleState,
  overrides: Partial<Parameters<typeof advanceBusLifecycle>[1]> = {},
) {
  return advanceBusLifecycle(state, {
    dt: 0.1,
    speed: 8,
    doorOpenFraction: 0,
    stopReached: false,
    requestedStop: false,
    busOffscreen: false,
    ...overrides,
  });
}

describe('bus lifecycle', () => {
  it('allows world relocation only after the bus is fully reset', () => {
    expect(canRelocateWorld(createBusLifecycle())).toBe(true);
    for (const phase of ['driving', 'braking', 'door-opening', 'alighting', 'waiting', 'departing'] as const) {
      expect(canRelocateWorld({ ...createBusLifecycle(), phase })).toBe(false);
    }
  });

  it('starts hidden and begins a confirmed route in driving', () => {
    expect(createBusLifecycle()).toEqual({
      phase: 'hidden',
      phaseSeconds: 0,
      alightProgress: 0,
      departureMeters: 0,
    });
    expect(advance(createBusLifecycle(), { requestedStart: true }).phase).toBe('driving');
  });

  it('brakes once for a requested or natural stop', () => {
    const driving = { ...createBusLifecycle(), phase: 'driving' as const };
    const braking = advance(driving, { requestedStop: true });
    expect(braking.phase).toBe('braking');
    expect(advance(braking, { requestedStop: true }).phase).toBe('braking');
    expect(advance(driving, { stopReached: true }).phase).toBe('braking');
  });

  it('opens the door at rest and automatically alights', () => {
    const braking = { ...createBusLifecycle(), phase: 'braking' as const };
    const opening = advance(braking, { speed: 0, stopReached: true });
    expect(opening.phase).toBe('door-opening');

    const alighting = advance(opening, { speed: 0, doorOpenFraction: 0.99 });
    expect(alighting.phase).toBe('alighting');
    expect(advance(alighting, { dt: 0.5, speed: 0 }).alightProgress).toBeGreaterThan(0);
  });

  it('waits 2.5 seconds after the pill reaches the curb', () => {
    let state: BusLifecycleState = {
      ...createBusLifecycle(),
      phase: 'alighting',
      alightProgress: 0.99,
    };
    state = advance(state, { dt: 1, speed: 0 });
    expect(state.phase).toBe('waiting');
    state = advance(state, { dt: 2.49, speed: 0 });
    expect(state.phase).toBe('waiting');
    state = advance(state, { dt: 0.02, speed: 0 });
    expect(state.phase).toBe('departing');
  });

  it('hides after 80 metres or when departure is offscreen', () => {
    const departing: BusLifecycleState = {
      ...createBusLifecycle(),
      phase: 'departing',
      departureMeters: 79,
    };
    expect(advance(departing, { dt: 0.2, speed: 4 }).phase).toBe('departing');
    expect(advance(departing, { dt: 0.5, speed: 4 }).phase).toBe('hidden');
    expect(advance(departing, { busOffscreen: true }).phase).toBe('hidden');
  });
});
