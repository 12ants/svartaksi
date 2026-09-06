import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyCarControls,
  CAR_COM_HEIGHT,
  CAR_MASS,
  CAR_MAX_STEER,
  createCarVehicle,
  syncCarBodyFromGroup,
  syncCarPose,
  syncCarWheels,
} from '../../src/svartaksi/carPhysics';
import { createCarModel, CAR_WHEEL_RADIUS } from '../../src/svartaksi/carModel';

const still = { forward: 0, turn: 0, brake: false, boost: false };

describe('createCarVehicle', () => {
  it('builds four wheels, steered at the front and braked hardest there', () => {
    const vehicle = createCarVehicle();
    expect(vehicle.wheels).toHaveLength(4);
    expect(vehicle.wheels.filter((wheel) => wheel.spec.steered)).toHaveLength(2);
    const front = vehicle.wheels.filter((wheel) => wheel.spec.steered);
    const rear = vehicle.wheels.filter((wheel) => !wheel.spec.steered);
    expect(front[0].spec.brakeShare).toBeGreaterThan(rear[0].spec.brakeShare);
    // Brake shares add up to the whole of the demanded effort, not to more or less of it.
    const total = vehicle.wheels.reduce((sum, wheel) => sum + wheel.spec.brakeShare, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('puts the front wheels ahead of the rear, in the order the model draws them', () => {
    const vehicle = createCarVehicle();
    expect(vehicle.wheels[0].spec.connection.z).toBeGreaterThan(0);
    expect(vehicle.wheels[1].spec.connection.z).toBeGreaterThan(0);
    expect(vehicle.wheels[2].spec.connection.z).toBeLessThan(0);
    expect(vehicle.wheels[3].spec.connection.z).toBeLessThan(0);
  });

  it('gives the front more grip than the rear, so it understeers rather than spins', () => {
    const vehicle = createCarVehicle();
    expect(vehicle.wheels[0].spec.grip).toBeGreaterThan(vehicle.wheels[2].spec.grip);
  });
});

describe('applyCarControls', () => {
  it('turns the wheel further at a standstill than at speed', () => {
    const slow = createCarVehicle();
    applyCarControls(slow, { ...still, turn: 1 }, 1 / 60);
    const fast = createCarVehicle();
    fast.chassis.linearVelocity.set(0, 0, 30);
    applyCarControls(fast, { ...still, turn: 1 }, 1 / 60);
    // Both are asked for full lock; only the standing one is given much of it.
    for (let step = 0; step < 60; step += 1) {
      applyCarControls(slow, { ...still, turn: 1 }, 1 / 60);
      slow.update(1 / 60, () => null);
      applyCarControls(fast, { ...still, turn: 1 }, 1 / 60);
      fast.update(1 / 60, () => null);
    }
    expect(slow.wheels[0].steer).toBeGreaterThan(fast.wheels[0].steer * 1.5);
    expect(slow.wheels[0].steer).toBeLessThanOrEqual(CAR_MAX_STEER + 1e-9);
  });

  it('slows the car with aerodynamic drag even off the throttle', () => {
    const vehicle = createCarVehicle();
    vehicle.chassis.linearVelocity.set(0, 0, 40);
    applyCarControls(vehicle, still, 1 / 60);
    expect(vehicle.chassis.linearVelocity.z).toBeLessThan(40);
  });

  it('applies more drag the faster it is going', () => {
    const slow = createCarVehicle();
    slow.chassis.linearVelocity.set(0, 0, 10);
    applyCarControls(slow, still, 1 / 60);
    const fast = createCarVehicle();
    fast.chassis.linearVelocity.set(0, 0, 40);
    applyCarControls(fast, still, 1 / 60);
    expect(40 - fast.chassis.linearVelocity.z).toBeGreaterThan((10 - slow.chassis.linearVelocity.z) * 4);
  });

  it('leaves a stationary car alone rather than pushing it about with drag', () => {
    const vehicle = createCarVehicle();
    applyCarControls(vehicle, still, 1 / 60);
    expect(vehicle.chassis.linearVelocity.length()).toBe(0);
  });

  it('weighs what a small hatchback weighs', () => {
    expect(createCarVehicle().chassis.mass).toBe(CAR_MASS);
  });
});

describe('syncing the model to the body', () => {
  it('puts the car group on the road under its centre of mass', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(12, CAR_COM_HEIGHT, -7);
    syncCarPose(model, vehicle);
    expect(model.group.position.x).toBeCloseTo(12, 6);
    expect(model.group.position.y).toBeCloseTo(0, 6);
    expect(model.group.position.z).toBeCloseTo(-7, 6);
  });

  it('offsets the group along the body\'s own axes, so it leans about its centre of mass', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, CAR_COM_HEIGHT, 0);
    vehicle.chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    syncCarPose(model, vehicle);
    // Rolled onto its side, "down" for the body points along -x, so the group's origin
    // moves out sideways rather than staying under the centre of mass.
    expect(model.group.position.x).toBeCloseTo(CAR_COM_HEIGHT, 5);
    expect(model.group.position.y).toBeCloseTo(CAR_COM_HEIGHT, 5);
  });

  it('sets each wheel at its own strut length', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    // At full extension the wheel hangs a whole strut below its mounting point.
    for (const wheel of vehicle.wheels) wheel.suspensionLength = wheel.spec.suspensionRest;
    syncCarWheels(model, vehicle);
    const expected = vehicle.wheels[0].spec.connection.y
      - vehicle.wheels[0].spec.suspensionRest + CAR_COM_HEIGHT;
    expect(model.wheels[0].position.y).toBeCloseTo(expected, 6);
    // And with the strut compressed, the wheel is higher into the arch.
    vehicle.wheels[0].suspensionLength -= 0.1;
    syncCarWheels(model, vehicle);
    expect(model.wheels[0].position.y).toBeCloseTo(expected + 0.1, 6);
  });

  it('steers and rolls the wheel it is given', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    vehicle.wheels[0].steer = 0.4;
    vehicle.wheels[0].roll = 1.2;
    syncCarWheels(model, vehicle);
    const euler = new THREE.Euler().setFromQuaternion(model.wheels[0].quaternion, 'YXZ');
    expect(euler.y).toBeCloseTo(0.4, 5);
    expect(euler.x).toBeCloseTo(1.2, 5);
  });

  it('leaves a resting wheel exactly at its drawn ride height', () => {
    const model = createCarModel();
    const fresh = createCarModel();
    const vehicle = createCarVehicle();
    // The strut length that puts the wheel centre one radius above the road.
    for (const wheel of vehicle.wheels) {
      wheel.suspensionLength = wheel.spec.connection.y + CAR_COM_HEIGHT - CAR_WHEEL_RADIUS;
    }
    syncCarWheels(model, vehicle);
    expect(model.wheels[0].position.y).toBeCloseTo(fresh.wheels[0].position.y, 6);
  });
});

describe('syncCarBodyFromGroup', () => {
  it('puts the body back on the group, at rest, wherever the game parked it', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    model.group.position.set(-40, 0, 90);
    model.group.rotation.y = 1.1;
    vehicle.chassis.linearVelocity.set(9, 3, -2);
    vehicle.chassis.angularVelocity.set(1, 1, 1);
    syncCarBodyFromGroup(vehicle, model.group);
    expect(vehicle.chassis.position.x).toBeCloseTo(-40, 6);
    expect(vehicle.chassis.position.y).toBeCloseTo(CAR_COM_HEIGHT, 6);
    expect(vehicle.chassis.position.z).toBeCloseTo(90, 6);
    expect(vehicle.chassis.linearVelocity.length()).toBe(0);
    expect(vehicle.chassis.angularVelocity.length()).toBe(0);
    expect(new THREE.Euler().setFromQuaternion(vehicle.chassis.quaternion, 'YXZ').y).toBeCloseTo(1.1, 6);
  });

  it('round-trips: syncing back out puts the car exactly where it was', () => {
    const model = createCarModel();
    const vehicle = createCarVehicle();
    model.group.position.set(3, 0, -8);
    model.group.rotation.y = -0.7;
    syncCarBodyFromGroup(vehicle, model.group);
    syncCarPose(model, vehicle);
    expect(model.group.position.x).toBeCloseTo(3, 6);
    expect(model.group.position.y).toBeCloseTo(0, 6);
    expect(model.group.position.z).toBeCloseTo(-8, 6);
  });
});
