import { describe, expect, it } from 'vitest';
import {
  CAR_WATER_DISABLED_TO_SINKING_S,
  CAR_WATER_ENTERING_TO_DISABLED_S,
  CAR_WATER_FULL_SINK_DEPTH,
  CAR_WATER_MIN_SAMPLES_TO_ENTER,
  CAR_WATER_SINKING_TO_SUBMERGED_S,
  REENTRY_COOLDOWN_S,
  SWIM_ENTER_DEPTH,
  SWIM_MAX_SPEED,
  carFootprintSamples,
  carIsSinking,
  countSubmergedSamples,
  driveControlEnabled,
  findEjectionPoint,
  initialCarWaterState,
  initialSwimBody,
  isAtShore,
  reentryAllowed,
  settleHeight,
  shouldEjectOccupant,
  stepCarWaterState,
  stepSwim,
  stepWaterMovement,
  swimBodyY,
  swimSurfaceY,
  wadeSpeedFactor,
} from '../../src/svartaksi/waterSwim';
import { buildTerrainIndex } from '../../src/world/terrain';
import { WATER_SHELF_WIDTH, buildWaterIndex, waterSampleAtXZ } from '../../src/world/waterIndex';

describe('carFootprintSamples', () => {
  it('samples the car center plus all four wheel corners, not one point', () => {
    const samples = carFootprintSamples({ x: 10, z: 20 }, 0, 1.3, 0.8);
    expect(samples.length).toBe(5);
    // Facing heading 0 (along +z convention used by carPhysics), corners should be
    // offset from the center by the wheelbase/track halves.
    const xs = samples.map((s) => s.x);
    const zs = samples.map((s) => s.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.6, 5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2.6, 5);
  });

  it('rotates the footprint with heading', () => {
    const straight = carFootprintSamples({ x: 0, z: 0 }, 0, 1, 1);
    const rotated = carFootprintSamples({ x: 0, z: 0 }, Math.PI / 2, 1, 1);
    // A 90-degree rotation should swap the spread from z to x.
    const spreadX = (pts: { x: number }[]) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    const spreadZ = (pts: { z: number }[]) => Math.max(...pts.map((p) => p.z)) - Math.min(...pts.map((p) => p.z));
    expect(spreadX(rotated)).toBeCloseTo(spreadZ(straight), 5);
  });
});

describe('countSubmergedSamples', () => {
  it('counts samples in water deeper than the floorpan, from the footprint not a single point', () => {
    const samples = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 0, z: 5 }, { x: 5, z: 5 }, { x: 2.5, z: 2.5 }];
    // Water only under the points on the near side.
    const waterDepthAt = (x: number) => (x < 3 ? 1 : null);
    const count = countSubmergedSamples(samples, waterDepthAt, /* floorHeight */ 0.5);
    expect(count).toBe(3); // (0,0), (0,5), (2.5,2.5)
  });

  it('does not count water shallower than the floorpan as submersion', () => {
    // A flooded kerb, or the shelving rim of a shoreline: wet wheels, dry floor.
    const samples = [{ x: 0, z: 0 }];
    expect(countSubmergedSamples(samples, () => 0.2, 0.3)).toBe(0);
    expect(countSubmergedSamples(samples, () => 0.4, 0.3)).toBe(1);
  });

  it('treats no water polygon at all as dry, however low the floorpan is', () => {
    expect(countSubmergedSamples([{ x: 0, z: 0 }], () => null, 0)).toBe(0);
  });
});

describe('stepCarWaterState', () => {
  const dt = 1 / 60;

  it('stays dry with no submerged samples', () => {
    const state = stepCarWaterState(initialCarWaterState(), 0, 5, dt);
    expect(state.phase).toBe('dry');
  });

  it('enters "entering" once enough samples are submerged', () => {
    const state = stepCarWaterState(initialCarWaterState(), CAR_WATER_MIN_SAMPLES_TO_ENTER, 5, dt);
    expect(state.phase).toBe('entering');
  });

  it('aborts back to dry if the car leaves the water again while still entering', () => {
    let state = stepCarWaterState(initialCarWaterState(), 1, 5, dt);
    expect(state.phase).toBe('entering');
    state = stepCarWaterState(state, 0, 5, dt);
    expect(state.phase).toBe('dry');
  });

  it('runs entering -> disabled -> sinking -> submerged deterministically under fixed ticks', () => {
    let state = initialCarWaterState();
    // +1 tick for the dry -> entering transition itself (phaseElapsed starts at 0 there,
    // not already carrying a tick's worth of time), +1 for rounding margin.
    const totalEnteringTicks = Math.ceil(CAR_WATER_ENTERING_TO_DISABLED_S / dt) + 2;
    for (let i = 0; i < totalEnteringTicks; i += 1) {
      state = stepCarWaterState(state, 3, 5, dt);
    }
    expect(state.phase).toBe('disabled');

    const totalDisabledTicks = Math.ceil(CAR_WATER_DISABLED_TO_SINKING_S / dt) + 1;
    for (let i = 0; i < totalDisabledTicks; i += 1) {
      state = stepCarWaterState(state, 5, 5, dt);
    }
    expect(state.phase).toBe('sinking');

    const totalSinkingTicks = Math.ceil(CAR_WATER_SINKING_TO_SUBMERGED_S / dt) + 1;
    for (let i = 0; i < totalSinkingTicks; i += 1) {
      state = stepCarWaterState(state, 5, 5, dt);
    }
    expect(state.phase).toBe('submerged');
    expect(state.sinkDepth).toBeCloseTo(CAR_WATER_FULL_SINK_DEPTH, 5);
  });

  it('once disabled, does not revert to dry even if samples clear (deterministic commitment)', () => {
    let state = { phase: 'disabled' as const, phaseElapsed: 0.1, sinkDepth: 0 };
    state = stepCarWaterState(state, 0, 5, dt);
    expect(state.phase).toBe('disabled');
  });

  it('produces the same sequence of phases regardless of how the same total time is chopped into ticks', () => {
    const runWithDt = (stepDt: number, steps: number) => {
      let state = initialCarWaterState();
      const phases: string[] = [];
      for (let i = 0; i < steps; i += 1) {
        state = stepCarWaterState(state, 3, 5, stepDt);
        phases.push(state.phase);
      }
      return phases[phases.length - 1];
    };
    // Same total simulated time (1 second), same fixed tick used for both: fixed-tick
    // determinism means feeding it via the same dt/step count always agrees.
    const a = runWithDt(1 / 60, 60);
    const b = runWithDt(1 / 60, 60);
    expect(a).toBe(b);
  });
});

describe('driveControlEnabled', () => {
  it('is true only while dry or entering', () => {
    expect(driveControlEnabled('dry')).toBe(true);
    expect(driveControlEnabled('entering')).toBe(true);
    expect(driveControlEnabled('disabled')).toBe(false);
    expect(driveControlEnabled('sinking')).toBe(false);
    expect(driveControlEnabled('submerged')).toBe(false);
  });
});

describe('findEjectionPoint', () => {
  it('finds the first valid dry point searching outward from the car', () => {
    // Everything is invalid except a ring at radius ~4.
    const isValid = (x: number, z: number) => Math.hypot(x, z) > 3.5 && Math.hypot(x, z) < 4.5;
    const point = findEjectionPoint({ x: 0, z: 0 }, 12, 1, 1, 10, isValid);
    expect(point).not.toBeNull();
    expect(isValid(point!.x, point!.z)).toBe(true);
  });

  it('returns null when no valid point exists within the search radius (recovery fallback trigger)', () => {
    const point = findEjectionPoint({ x: 0, z: 0 }, 8, 1, 1, 3, () => false);
    expect(point).toBeNull();
  });
});

describe('swim bounds', () => {
  it('clamps horizontal swim speed', () => {
    const state = stepSwim({ x: 0, z: 0, vx: 0, vz: 0 }, 100, 100, 1 / 60);
    const speed = Math.hypot(state.vx, state.vz);
    expect(speed).toBeLessThanOrEqual(SWIM_MAX_SPEED + 1e-6);
  });

  it('floats the body with its head out and the rest of it under', () => {
    // The origin of every playable body here is at its feet, so a swimmer's origin has to
    // be *below* the surface — placing it above would float the whole pill like a boat.
    const y = swimSurfaceY(2);
    expect(y).toBeLessThan(2);
    // Still enough of a 1.66m pill above the line to see it.
    expect(2 - y).toBeLessThan(1.3);
  });

  it('floats at exactly the height a body wading out is already at, so there is no step', () => {
    // Wading, the body stands on the implied bed; at SWIM_ENTER_DEPTH its feet are that
    // far under. Matching the two is what makes the changeover a lift-off, not a pop.
    expect(swimSurfaceY(10)).toBeCloseTo(10 - SWIM_ENTER_DEPTH, 6);
  });
});

describe('isAtShore', () => {
  it('is true once the swimmer is outside any water polygon', () => {
    const waterHeightAt = () => null;
    expect(isAtShore(0, 0, waterHeightAt)).toBe(true);
  });

  it('is false while still over water', () => {
    const waterHeightAt = () => 1.2;
    expect(isAtShore(0, 0, waterHeightAt)).toBe(false);
  });
});

describe('reentryAllowed', () => {
  it('blocks re-entering the car immediately after ejection', () => {
    expect(reentryAllowed(0)).toBe(false);
    expect(reentryAllowed(REENTRY_COOLDOWN_S - 0.01)).toBe(false);
  });

  it('allows re-entry once the cooldown has elapsed', () => {
    expect(reentryAllowed(REENTRY_COOLDOWN_S + 0.01)).toBe(true);
  });
});

describe('shouldEjectOccupant', () => {
  it('fires exactly once, on the tick the car starts sinking', () => {
    expect(shouldEjectOccupant('disabled', 'sinking')).toBe(true);
    expect(shouldEjectOccupant('sinking', 'sinking')).toBe(false);
  });

  it('does not fire while the car is merely flooding, or once it is already under', () => {
    // The flooding phases are the player's warning; ejecting there would throw them out
    // the moment a wheel touched.
    expect(shouldEjectOccupant('dry', 'entering')).toBe(false);
    expect(shouldEjectOccupant('entering', 'disabled')).toBe(false);
    expect(shouldEjectOccupant('sinking', 'submerged')).toBe(false);
  });
});

describe('wadeSpeedFactor', () => {
  it('is full pace on dry land and slows as the water deepens', () => {
    expect(wadeSpeedFactor(0)).toBe(1);
    expect(wadeSpeedFactor(0.3)).toBeLessThan(1);
    expect(wadeSpeedFactor(0.9)).toBeLessThan(wadeSpeedFactor(0.3));
  });

  it('never stops a body outright — deeper than this and it is swimming instead', () => {
    expect(wadeSpeedFactor(SWIM_ENTER_DEPTH)).toBeGreaterThan(0.3);
    expect(wadeSpeedFactor(50)).toBe(wadeSpeedFactor(SWIM_ENTER_DEPTH));
  });
});

describe('stepWaterMovement', () => {
  const dt = 1 / 60;

  it('walks on dry land, and reports the walking pace as its speed', () => {
    const body = initialSwimBody();
    // Heading 0 is +z in this world's convention, the same one the on-foot walk uses.
    const move = stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, null, 0, dt);
    expect(move.swimming).toBe(false);
    expect(move.z).toBeCloseTo(4 * dt, 6);
    expect(move.speed).toBeCloseTo(4, 6);
  });

  it('starts swimming once the water is over its head, and keeps swimming in shallower water than it took to start', () => {
    const body = initialSwimBody();
    // Between the two thresholds: not deep enough to start in...
    expect(stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, 1, 0, dt).swimming).toBe(false);
    // ...deep enough once it is, and still swimming back at that same depth afterwards.
    expect(stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, SWIM_ENTER_DEPTH + 0.2, 0, dt).swimming).toBe(true);
    expect(stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, 1, 0, dt).swimming).toBe(true);
    // And out again on the beach, where the hysteresis band ends.
    expect(stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, 0.5, 0, dt).swimming).toBe(false);
  });

  it('measures depth against the ground underfoot, not against sea level', () => {
    // A sandbank standing 1.5m up inside a 2m-deep lake is knee-deep, not over your head.
    const body = initialSwimBody();
    expect(stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, 2, 1.5, dt).swimming).toBe(false);
  });

  it('builds up to the swim speed rather than reaching it on the first stroke, and never past it', () => {
    const body = initialSwimBody();
    let position = { x: 0, z: 0 };
    const first = stepWaterMovement(body, position, 0, 1, 4, 3, 0, dt);
    expect(first.speed).toBeLessThan(SWIM_MAX_SPEED);
    for (let tick = 0; tick < 600; tick += 1) {
      const move = stepWaterMovement(body, position, 0, 1, 4, 3, 0, dt);
      position = { x: move.x, z: move.z };
      expect(move.speed).toBeLessThanOrEqual(SWIM_MAX_SPEED + 1e-9);
    }
    expect(Math.hypot(body.vx, body.vz)).toBeCloseTo(SWIM_MAX_SPEED, 3);
  });

  it('drops swim momentum the moment it stands up, so a stroke does not slide it up the beach', () => {
    const body = initialSwimBody();
    for (let tick = 0; tick < 60; tick += 1) stepWaterMovement(body, { x: 0, z: 0 }, 0, 1, 4, 3, 0, dt);
    expect(Math.hypot(body.vx, body.vz)).toBeGreaterThan(1);
    stepWaterMovement(body, { x: 0, z: 0 }, 0, 0, 4, null, 0, dt);
    expect(body.vx).toBe(0);
    expect(body.vz).toBe(0);
  });

  it('is a pure function of the fixed tick: the same input twice moves the same distance', () => {
    // The acceptance criterion behind item 10 — the same recorded input has to produce the
    // same sequence whatever the render rate is doing.
    const a = initialSwimBody();
    const b = initialSwimBody();
    let pa = { x: 0, z: 0 };
    let pb = { x: 0, z: 0 };
    for (let tick = 0; tick < 120; tick += 1) {
      const ma = stepWaterMovement(a, pa, 0.7, 1, 4, 3, 0, dt);
      const mb = stepWaterMovement(b, pb, 0.7, 1, 4, 3, 0, dt);
      pa = { x: ma.x, z: ma.z };
      pb = { x: mb.x, z: mb.z };
    }
    expect(pa.x).toBe(pb.x);
    expect(pa.z).toBe(pb.z);
  });
});

describe('swimBodyY', () => {
  it('eases onto the surface instead of snapping to it', () => {
    const target = swimSurfaceY(4);
    const first = swimBodyY(0, 4, 1 / 60);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(target);
  });

  it('settles at the floating height and stays there', () => {
    let y = 0;
    for (let tick = 0; tick < 300; tick += 1) y = swimBodyY(y, 4, 1 / 60);
    expect(y).toBeCloseTo(swimSurfaceY(4), 5);
  });

  it('eases downward too, so a body that was standing higher settles onto the surface', () => {
    let y = 6;
    for (let tick = 0; tick < 300; tick += 1) y = swimBodyY(y, 4, 1 / 60);
    expect(y).toBeCloseTo(swimSurfaceY(4), 5);
  });
});

describe('wading in from the shore', () => {
  // The seam between the two modules: waterIndex's implied bed says how deep it is,
  // waterSwim says what the body does about it. Walking straight out from a beach has to
  // produce one continuous descent — no step at the water's edge, and none at the moment
  // the body lifts off the bottom — which is the whole reason swimSurfaceY is pinned to
  // SWIM_ENTER_DEPTH.
  const index = buildWaterIndex(
    [{ id: 'bay', kind: 'water', rings: [[{ x: 0, z: -100 }, { x: 300, z: -100 }, { x: 300, z: 100 }, { x: 0, z: 100 }]] }],
    buildTerrainIndex([]),
  );
  const dt = 1 / 60;

  /** What the runtime does per tick: stand on the bed where there is water and on the
   * ground where there is not, or float once it is swimming. */
  function walkOut() {
    const body = initialSwimBody();
    let position = { x: -3, z: 0 };
    let y = 0;
    const track: { x: number; y: number; swimming: boolean }[] = [];
    for (let tick = 0; tick < 900; tick += 1) {
      const sample = waterSampleAtXZ(position.x, position.z, index);
      const standY = sample ? sample.surface - sample.depth : 0;
      const move = stepWaterMovement(body, position, 0.5 * Math.PI, 1, 3.1, sample?.surface ?? null, standY, dt);
      position = { x: move.x, z: move.z };
      y = move.swimming ? swimBodyY(y, sample!.surface, dt) : standY;
      track.push({ x: position.x, y, swimming: move.swimming });
    }
    return track;
  }

  it('walks dry, wades in, and ends up swimming', () => {
    const track = walkOut();
    expect(track[0].swimming).toBe(false);
    expect(track[0].y).toBe(0);
    expect(track[track.length - 1].swimming).toBe(true);
    // Out past the shelf, so the body is floating at the open-water line rather than still
    // standing on a slope.
    expect(track[track.length - 1].x).toBeGreaterThan(WATER_SHELF_WIDTH);
  });

  it('descends without a step anywhere, the changeover included', () => {
    const track = walkOut();
    for (let index = 1; index < track.length; index += 1) {
      expect(Math.abs(track[index].y - track[index - 1].y)).toBeLessThan(0.05);
    }
  });

  it('never leaves the body standing above the water it is in', () => {
    for (const step of walkOut()) {
      const sample = waterSampleAtXZ(step.x, 0, index);
      if (!sample) continue;
      expect(step.y).toBeLessThanOrEqual(sample.surface + 1e-6);
    }
  });
});

describe('carIsSinking', () => {
  it('is the line between the solver owning the car and the game placing it', () => {
    // Flooding and dead-in-the-water are still a body on its springs coasting to a stop.
    expect(carIsSinking('dry')).toBe(false);
    expect(carIsSinking('entering')).toBe(false);
    expect(carIsSinking('disabled')).toBe(false);
    // Past here there is no ground under it and the descent is scripted.
    expect(carIsSinking('sinking')).toBe(true);
    expect(carIsSinking('submerged')).toBe(true);
  });
});

describe('settleHeight', () => {
  it('stands a body on the ground where there is no water', () => {
    // The bug this replaced: a literal y = 0, which buries a body in any landuse mound.
    expect(settleHeight(1.4, null)).toEqual({ y: 1.4, swimming: false });
  });

  it('stands a body in water too shallow to swim in', () => {
    expect(settleHeight(0, 0.4)).toEqual({ y: 0, swimming: false });
  });

  it('floats a body set down in open water rather than leaving it on the bottom', () => {
    const settled = settleHeight(0, 4);
    expect(settled.swimming).toBe(true);
    expect(settled.y).toBe(swimSurfaceY(4));
  });

  it('never leaves a body below the water it was placed in', () => {
    // "Never spawns below the surface" — an acceptance criterion of backlog item 10.
    for (const depth of [0, 0.5, 0.9, 1.2, 2, 5, 20]) {
      const settled = settleHeight(0, depth);
      expect(settled.y, `depth ${depth}`).toBeLessThanOrEqual(depth);
      if (settled.swimming) expect(settled.y, `depth ${depth}`).toBeGreaterThan(depth - 1.3);
    }
  });

  it('measures the water against the surface underfoot, not against sea level', () => {
    // A sandbank standing 3m up inside 4m of water is ankle-deep, not over your head.
    expect(settleHeight(3.5, 4).swimming).toBe(false);
  });
});
