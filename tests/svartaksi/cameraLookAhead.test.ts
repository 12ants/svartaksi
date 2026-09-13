import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyCameraLookAhead, createHeadingRateTracker, lookAheadLateralOffset, modeTakesLookAhead,
} from '../../src/svartaksi/cameraLookAhead';
import { CAMERA } from '../../src/svartaksi/gameplayConfig';
import type { CameraMode } from '../../src/svartaksi/cameraModes';

/** Facing due north in this renderer's convention: forward = (sin h, 0, cos h). */
const NORTH = 0;
const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const placement = (position: THREE.Vector3, lookAt: THREE.Vector3) => ({ position, lookAt });

describe('createHeadingRateTracker', () => {
  it('reports no turn on the first sample, having nothing to difference against', () => {
    const tracker = createHeadingRateTracker();
    expect(tracker.update(1.2, 1 / 60)).toBe(0);
  });

  it('converges on the true rate of a steady turn', () => {
    const tracker = createHeadingRateTracker();
    const dt = 1 / 60;
    const rate = 0.5;
    let heading = NORTH;
    let observed = 0;
    // Two seconds is many multiples of the smoothing time constant, so the filter has
    // settled and what is left is the rate itself rather than its approach.
    for (let step = 0; step < 120; step += 1) {
      heading += rate * dt;
      observed = tracker.update(heading, dt);
    }
    expect(observed).toBeCloseTo(rate, 2);
  });

  it('signs a right turn negative, matching this world\'s counterclockwise yaw', () => {
    const tracker = createHeadingRateTracker();
    const dt = 1 / 60;
    let heading = NORTH;
    let observed = 0;
    for (let step = 0; step < 120; step += 1) {
      heading -= 0.5 * dt;
      observed = tracker.update(heading, dt);
    }
    expect(observed).toBeLessThan(0);
    expect(observed).toBeCloseTo(-0.5, 2);
  });

  it('reads a turn through the +/-pi seam as a small turn, not a full revolution', () => {
    const tracker = createHeadingRateTracker();
    const dt = 1 / 60;
    // Straddling the wrap: without angle wrapping the difference reads as nearly -2pi,
    // which at 60Hz is a rate of some 375 rad/s and would fling the shot off the car.
    tracker.update(Math.PI - 0.01, dt);
    const observed = tracker.update(-Math.PI + 0.01, dt);
    expect(Math.abs(observed)).toBeLessThan(CAMERA.lookAheadMaxTurnRate + 1e-6);
  });

  it('clamps a heading discontinuity to the plausible maximum', () => {
    const tracker = createHeadingRateTracker();
    const dt = 1 / 60;
    tracker.update(0, dt);
    // A teleport or a body swap moves the heading instantly; the raw derivative is huge.
    const observed = tracker.update(3, dt);
    expect(Math.abs(observed)).toBeLessThanOrEqual(CAMERA.lookAheadMaxTurnRate);
  });

  it('ignores a frame with no elapsed time rather than dividing by it', () => {
    const tracker = createHeadingRateTracker();
    tracker.update(0, 1 / 60);
    expect(Number.isFinite(tracker.update(0.1, 0))).toBe(true);
  });
});

describe('lookAheadLateralOffset', () => {
  it('is zero in a straight line, however fast', () => {
    expect(lookAheadLateralOffset(0, 26, 1)).toBe(0);
  });

  it('is zero when parked, however hard the wheel is turned', () => {
    expect(lookAheadLateralOffset(0.8, 0, 1)).toBe(0);
  });

  it('is zero at gain zero, which is what the dial is for', () => {
    expect(lookAheadLateralOffset(0.8, 20, 0)).toBe(0);
  });

  it('leads to the left in a left turn and to the right in a right one', () => {
    expect(lookAheadLateralOffset(0.5, 20, 1)).toBeGreaterThan(0);
    expect(lookAheadLateralOffset(-0.5, 20, 1)).toBeLessThan(0);
  });

  it('is half the lateral acceleration over the look-ahead time squared', () => {
    const turnRate = 0.4;
    const speed = 18;
    // a = v * omega is the centripetal acceleration; the offset is where that carries
    // the car in CAMERA.lookAheadTime seconds.
    const expected = 0.5 * speed * turnRate * CAMERA.lookAheadTime ** 2;
    expect(lookAheadLateralOffset(turnRate, speed, 1)).toBeCloseTo(expected, 6);
  });

  it('grows with the gain dial', () => {
    const gentle = lookAheadLateralOffset(0.4, 18, 0.5);
    const full = lookAheadLateralOffset(0.4, 18, 1);
    expect(full).toBeGreaterThan(gentle);
  });

  it('never exceeds the cap, however violent the manoeuvre', () => {
    const extreme = lookAheadLateralOffset(CAMERA.lookAheadMaxTurnRate, 150, 2);
    expect(extreme).toBeLessThanOrEqual(CAMERA.lookAheadMaxLateral);
    expect(extreme).toBeCloseTo(CAMERA.lookAheadMaxLateral, 6);
  });

  it('is subtle at ordinary town speeds, not a swing', () => {
    // 50km/h through a gentle bend, at the shipped default gain of 1.
    const offset = lookAheadLateralOffset(0.3, 14, 1);
    expect(offset).toBeGreaterThan(0.3);
    expect(offset).toBeLessThan(1.5);
  });
});

describe('applyCameraLookAhead', () => {
  it('moves the aim to the left of a body turning left, facing north', () => {
    // Facing north, forward is +z and +x is left of it — the convention cameraRig states.
    const shot = placement(at(0, 8, -16), at(0, 1, 0));
    applyCameraLookAhead(shot, NORTH, 0.5, 20, 1);

    expect(shot.lookAt.x).toBeGreaterThan(0);
    expect(shot.lookAt.z).toBeCloseTo(0, 6);
  });

  it('leaves the camera position alone — a lead is an aim, not a move', () => {
    const shot = placement(at(0, 8, -16), at(0, 1, 0));
    applyCameraLookAhead(shot, NORTH, 0.5, 20, 1);

    expect(shot.position.x).toBeCloseTo(0, 6);
    expect(shot.position.y).toBeCloseTo(8, 6);
    expect(shot.position.z).toBeCloseTo(-16, 6);
  });

  it('leaves the aim height alone, so a lead never tilts the horizon', () => {
    const shot = placement(at(0, 8, -16), at(0, 1.2, 0));
    applyCameraLookAhead(shot, NORTH, 0.7, 22, 1);

    expect(shot.lookAt.y).toBeCloseTo(1.2, 6);
  });

  it('swings the lead with the heading, staying left of a body facing east', () => {
    const east = Math.PI / 2;
    const shot = placement(at(-16, 8, 0), at(0, 1, 0));
    applyCameraLookAhead(shot, east, 0.5, 20, 1);

    // Facing east, forward is +x, so left is -z: right = forward x up = +z.
    expect(shot.lookAt.z).toBeLessThan(0);
    expect(shot.lookAt.x).toBeCloseTo(0, 6);
  });

  it('is an exact no-op at gain zero, down to the object identity of the shot', () => {
    const shot = placement(at(0, 8, -16), at(0, 1, 0));
    const returned = applyCameraLookAhead(shot, NORTH, 0.9, 24, 0);

    expect(returned).toBe(shot);
    expect(shot.lookAt.x).toBe(0);
    expect(shot.lookAt.z).toBe(0);
  });

  it('displaces the aim by exactly the offset it computes', () => {
    const shot = placement(at(0, 8, -16), at(5, 1, -3));
    const expected = lookAheadLateralOffset(0.6, 19, 1);
    applyCameraLookAhead(shot, NORTH, 0.6, 19, 1);

    expect(shot.lookAt.x - 5).toBeCloseTo(expected, 6);
  });
});

describe('modeTakesLookAhead', () => {
  it('leads the modes that frame the road ahead', () => {
    for (const mode of ['chase', 'hood', 'cockpit', 'cinematic'] as const) {
      expect(modeTakesLookAhead(mode)).toBe(true);
    }
  });

  it('leaves the modes that are not looking down the road alone', () => {
    // Top-down already shows the corner, orbit is a sweep of its own that a second moving
    // aim would only fight, and freecam is not following a body at all.
    for (const mode of ['top-down', 'orbit', 'freecam'] as const satisfies readonly CameraMode[]) {
      expect(modeTakesLookAhead(mode)).toBe(false);
    }
  });
});
