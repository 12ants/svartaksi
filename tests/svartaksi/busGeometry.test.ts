import { describe, expect, it } from 'vitest';
import {
  BUS_DIMENSIONS,
  chassisPoseFromAxles,
  computeAckermannAngles,
  computeMaxSteerAngle,
  computeMinTurnRadius,
  frontAxleFromRear,
  offsetAlongHeading,
  stepBicycleModel,
  type VehiclePose,
} from '../../src/svartaksi/busGeometry';

describe('bus dimension sheet', () => {
  it('derives maxSteerAngle and minTurnRadius from wheelbase, each the inverse of the other', () => {
    const { wheelbase, minTurnRadius, maxSteerAngle } = BUS_DIMENSIONS;
    expect(computeMaxSteerAngle(wheelbase, minTurnRadius)).toBeCloseTo(maxSteerAngle, 10);
    expect(computeMinTurnRadius(wheelbase, maxSteerAngle)).toBeCloseTo(minTurnRadius, 6);
  });

  it('keeps the axles a positive wheelbase apart, both inside the body length', () => {
    const { frontAxleZ, rearAxleZ, wheelbase, length } = BUS_DIMENSIONS;
    expect(frontAxleZ).toBeGreaterThan(rearAxleZ);
    expect(frontAxleZ - rearAxleZ).toBeCloseTo(wheelbase, 6);
    expect(frontAxleZ).toBeLessThan(length / 2);
    expect(rearAxleZ).toBeGreaterThan(-length / 2);
  });

  it('carries a longer wheelbase than the previous tuned model implied, for a bus this long', () => {
    expect(BUS_DIMENSIONS.wheelbase).toBeGreaterThan(6);
    expect(BUS_DIMENSIONS.length).toBeGreaterThan(10);
  });
});

describe('Ackermann angles', () => {
  const { wheelbase, track } = BUS_DIMENSIONS;

  it('points both wheels straight ahead when commanded angle is zero', () => {
    expect(computeAckermannAngles(0, wheelbase, track)).toEqual({ left: 0, right: 0 });
  });

  it('gives the inner (left) wheel a sharper angle than the outer (right) wheel on a left turn', () => {
    const { left, right } = computeAckermannAngles(0.4, wheelbase, track);
    expect(left).toBeGreaterThan(0.4);
    expect(right).toBeLessThan(0.4);
    expect(right).toBeGreaterThan(0);
  });

  it('mirrors onto the right wheel on a right turn', () => {
    const { left, right } = computeAckermannAngles(-0.4, wheelbase, track);
    expect(right).toBeLessThan(-0.4);
    expect(left).toBeGreaterThan(-0.4);
    expect(left).toBeLessThan(0);
  });

  it('has both wheels converge on the same angle as track narrows towards zero', () => {
    const { left, right } = computeAckermannAngles(0.4, wheelbase, 1e-9);
    expect(left).toBeCloseTo(right, 3);
  });

  it('does not blow up at an angle steep enough to put the inner turn circle inside the track', () => {
    const { left, right } = computeAckermannAngles(BUS_DIMENSIONS.maxSteerAngle * 3, wheelbase, track);
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(right)).toBe(true);
  });
});

describe('bicycle-model kinematics', () => {
  const { wheelbase, maxSteerAngle } = BUS_DIMENSIONS;

  it('places the front axle exactly one wheelbase ahead of the rear along its heading', () => {
    const rear: VehiclePose = { x: 3, z: -2, heading: 0.7 };
    const front = frontAxleFromRear(rear, wheelbase);
    expect(Math.hypot(front.x - rear.x, front.z - rear.z)).toBeCloseTo(wheelbase, 6);
  });

  it('holds the rear axle straight (heading unchanged) at zero steer', () => {
    let rear: VehiclePose = { x: 0, z: 0, heading: 0 };
    for (let i = 0; i < 50; i += 1) rear = stepBicycleModel(rear, 0, 10, wheelbase, 0.1);
    expect(rear.heading).toBeCloseTo(0, 9);
    expect(rear.x).toBeCloseTo(0, 6);
    expect(rear.z).toBeCloseTo(50, 6);
  });

  it('traces a circle of the design minimum radius at full lock, with the front axle outside it', () => {
    const speed = 8;
    const dt = 0.01;
    const steer = maxSteerAngle;
    const expectedRadius = computeMinTurnRadius(wheelbase, steer);
    // Starting at (-radius, 0) facing +z (heading 0, under forward = (sin h, 0, cos h)),
    // a positive (left) steer curves the path around the origin — the algebra: with
    // heading(t) = h0 + yawRate*t and h0 = 0, the trajectory's centre works out to
    // (x0 + radius, z0), so x0 = -radius puts that centre at the origin.
    let rear: VehiclePose = { x: -expectedRadius, z: 0, heading: 0 };

    // Run one full lap and sample the radius throughout — a constant-radius test, not
    // just a start/end check, so a model that drifts off the circle mid-turn is caught.
    const lapTime = (2 * Math.PI * expectedRadius) / speed;
    const steps = Math.round(lapTime / dt);
    let maxRearRadiusError = 0;
    let sawFrontOutsideRear = true;
    for (let i = 0; i < steps; i += 1) {
      rear = stepBicycleModel(rear, steer, speed, wheelbase, dt);
      const rearRadius = Math.hypot(rear.x, rear.z);
      maxRearRadiusError = Math.max(maxRearRadiusError, Math.abs(rearRadius - expectedRadius));

      const front = frontAxleFromRear(rear, wheelbase);
      const frontRadius = Math.hypot(front.x, front.z);
      if (frontRadius <= rearRadius) sawFrontOutsideRear = false;
    }

    // Euler integration drifts a little over a full lap; a fraction of a percent of the
    // radius is integration error, not a modelling error.
    expect(maxRearRadiusError).toBeLessThan(expectedRadius * 0.01);
    // The rear axle traces the design minimum radius...
    expect(Math.hypot(rear.x, rear.z)).toBeCloseTo(expectedRadius, 0);
    // ...and the front axle, one wheelbase further from the turn centre, cuts a wider
    // circle than the rear the whole way round: the rear axle cuts inside the front.
    expect(sawFrontOutsideRear).toBe(true);
  });

  it('does not rotate the chassis about its own centre — the body pose sits between the axles', () => {
    const front: VehiclePose = { x: 5, z: 5, heading: Math.PI / 4 };
    const rear: VehiclePose = { x: 0, z: 0, heading: Math.PI / 4 };
    const body = chassisPoseFromAxles(front, rear);
    expect(body.x).toBeCloseTo(2.5, 6);
    expect(body.z).toBeCloseTo(2.5, 6);
    // Facing from rear to front, not an independent value the two axles orbit around.
    expect(body.heading).toBeCloseTo(Math.atan2(5, 5), 6);
  });

  it('falls back to the front pose heading when the axles coincide, rather than dividing by zero', () => {
    const pose: VehiclePose = { x: 1, z: 1, heading: 1.2 };
    const body = chassisPoseFromAxles(pose, pose);
    expect(body.heading).toBeCloseTo(1.2, 9);
    expect(Number.isFinite(body.x)).toBe(true);
  });
});

describe('lane offset', () => {
  it('shifts a sampled point perpendicular to its heading, preserving the heading', () => {
    const offset = offsetAlongHeading({ x: 0, z: 0 }, 0, 2);
    // Heading 0 is +z; the perpendicular offset moves along +x with this convention.
    expect(offset.x).toBeCloseTo(2, 6);
    expect(offset.z).toBeCloseTo(0, 6);
    expect(offset.heading).toBe(0);
  });
});
