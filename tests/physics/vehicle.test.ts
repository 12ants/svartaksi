import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPhysicsWorld } from '../../src/physics/world';
import { createCarVehicle, applyCarControls, CAR_COM_HEIGHT } from '../../src/svartaksi/carPhysics';
import { CAR_WHEEL_RADIUS } from '../../src/svartaksi/carModel';
import type { RaycastVehicle } from '../../src/physics/vehicle';

function drive(
  vehicle: RaycastVehicle,
  world: ReturnType<typeof createPhysicsWorld>,
  seconds: number,
  input: { forward: number; turn: number; brake?: boolean; boost?: boolean },
): void {
  const dt = 1 / 60;
  for (let step = 0; step < Math.round(seconds / dt); step += 1) {
    applyCarControls(vehicle, {
      forward: input.forward,
      turn: input.turn,
      brake: input.brake ?? false,
      boost: input.boost ?? false,
    }, dt);
    world.step(dt);
  }
}

function onGround(): { world: ReturnType<typeof createPhysicsWorld>; vehicle: RaycastVehicle } {
  const world = createPhysicsWorld();
  const vehicle = createCarVehicle();
  vehicle.chassis.position.set(0, CAR_COM_HEIGHT, 0);
  world.addBody(vehicle.chassis);
  world.addVehicle(vehicle);
  return { world, vehicle };
}

describe('suspension', () => {
  it('holds the chassis up at its ride height instead of letting it sink', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 0, turn: 0 });
    // Dropped from its own ride height it should settle within a few centimetres of it.
    expect(vehicle.chassis.position.y).toBeGreaterThan(CAR_COM_HEIGHT - 0.12);
    expect(vehicle.chassis.position.y).toBeLessThan(CAR_COM_HEIGHT + 0.06);
  });

  it('finds the ground with every wheel and shares the load evenly at rest', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 0, turn: 0 });
    expect(vehicle.wheels.every((wheel) => wheel.grounded)).toBe(true);
    const loads = vehicle.wheels.map((wheel) => wheel.load);
    const total = loads.reduce((sum, load) => sum + load, 0);
    // Four struts between them carry the car's weight, near enough.
    expect(total).toBeGreaterThan(1250 * 9.81 * 0.8);
    expect(total).toBeLessThan(1250 * 9.81 * 1.2);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(total * 0.2);
  });

  it('compresses under the car rather than sitting at full extension', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 0, turn: 0 });
    for (const wheel of vehicle.wheels) {
      expect(wheel.suspensionLength).toBeLessThan(wheel.spec.suspensionRest);
    }
  });

  it('compresses only the strut whose own wheel is on a bump', () => {
    const world = createPhysicsWorld();
    // A kerb under the front wheel at (-1.08, 1.35) and nothing under the other three.
    world.setGroundHeight((x, z) => (x < -0.5 && z > 0.5 ? 0.06 : 0));
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, CAR_COM_HEIGHT, 0);
    world.addBody(vehicle.chassis);
    world.addVehicle(vehicle);
    drive(vehicle, world, 4, { forward: 0, turn: 0 });
    // That strut takes the bump and the one beside it on the same axle is unloaded by the
    // roll it causes — which is the whole point of independent suspension: a kerb under
    // one wheel is absorbed there instead of lifting the car off the road.
    expect(vehicle.wheels[0].suspensionLength).toBeLessThan(vehicle.wheels[1].suspensionLength);
    expect(vehicle.wheels[0].load).toBeGreaterThan(vehicle.wheels[1].load);
    expect(vehicle.wheels.every((wheel) => wheel.grounded)).toBe(true);
  });

  it('keeps the body parallel to a uniformly tilted road', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight((x) => x * 0.1);
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, CAR_COM_HEIGHT + 0.2, 0);
    world.addBody(vehicle.chassis);
    world.addVehicle(vehicle);
    drive(vehicle, world, 4, { forward: 0, turn: 0 });
    // Equal springs on an even slope compress equally, and the car simply leans with the
    // camber rather than one side riding higher on its springs than the other.
    const lengths = vehicle.wheels.map((wheel) => wheel.suspensionLength);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(0.02);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(vehicle.chassis.quaternion);
    expect(up.x).toBeLessThan(-0.05);
  });

  it('runs out of travel rather than reaching for ground that is not there', () => {
    const world = createPhysicsWorld();
    world.setGroundHeight(() => -50);
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, 0, 0);
    world.addBody(vehicle.chassis);
    world.addVehicle(vehicle);
    drive(vehicle, world, 0.5, { forward: 1, turn: 0 });
    expect(vehicle.wheels.every((wheel) => !wheel.grounded)).toBe(true);
    for (const wheel of vehicle.wheels) {
      expect(wheel.suspensionLength).toBeCloseTo(wheel.spec.suspensionRest + wheel.spec.maxTravel, 6);
      expect(wheel.load).toBe(0);
    }
  });
});

describe('driving', () => {
  it('accelerates forward on the throttle', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 3, { forward: 1, turn: 0 });
    expect(vehicle.forwardSpeed()).toBeGreaterThan(6);
    expect(vehicle.chassis.position.z).toBeGreaterThan(4);
  });

  it('settles at a top speed rather than accelerating forever', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 25, { forward: 1, turn: 0 });
    const early = vehicle.forwardSpeed();
    drive(vehicle, world, 15, { forward: 1, turn: 0 });
    expect(vehicle.forwardSpeed()).toBeLessThan(32);
    expect(vehicle.forwardSpeed() - early).toBeLessThan(3);
  });

  it('goes much faster on the boost', () => {
    const plain = onGround();
    drive(plain.vehicle, plain.world, 12, { forward: 1, turn: 0 });
    const boosted = onGround();
    drive(boosted.vehicle, boosted.world, 12, { forward: 1, turn: 0, boost: true });
    expect(boosted.vehicle.forwardSpeed()).toBeGreaterThan(plain.vehicle.forwardSpeed() * 1.5);
  });

  it('brakes to a stop', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 4, { forward: 1, turn: 0 });
    expect(vehicle.forwardSpeed()).toBeGreaterThan(5);
    drive(vehicle, world, 4, { forward: 0, turn: 0, brake: true });
    expect(Math.abs(vehicle.forwardSpeed())).toBeLessThan(0.5);
  });

  it('does not reverse under braking alone', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 1, turn: 0 });
    drive(vehicle, world, 6, { forward: 0, turn: 0, brake: true });
    expect(vehicle.forwardSpeed()).toBeGreaterThan(-0.2);
  });

  it('reverses on a negative throttle, and far more slowly than it goes forward', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 6, { forward: -1, turn: 0 });
    expect(vehicle.forwardSpeed()).toBeLessThan(-2);
    expect(vehicle.forwardSpeed()).toBeGreaterThan(-10);
  });

  it('turns left on a positive steering input', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 1, turn: 0 });
    const before = new THREE.Euler().setFromQuaternion(vehicle.chassis.quaternion, 'YXZ').y;
    drive(vehicle, world, 2, { forward: 1, turn: 1 });
    const after = new THREE.Euler().setFromQuaternion(vehicle.chassis.quaternion, 'YXZ').y;
    expect(after).toBeGreaterThan(before);
    expect(vehicle.chassis.position.x).toBeGreaterThan(0.5);
  });

  it('does not steer while it is standing still', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 2, { forward: 0, turn: 1 });
    expect(Math.abs(vehicle.chassis.position.x)).toBeLessThan(0.05);
  });

  it('leans into a corner', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 5, { forward: 1, turn: 0 });
    drive(vehicle, world, 1.5, { forward: 1, turn: 1 });
    // Forward is +z and +x is left of it, so wheels 1 and 3 (at +x) are the near side of
    // a left-hand bend and wheels 0 and 2 are the outside. Weight goes to the outside.
    const insideLoad = vehicle.wheels[1].load + vehicle.wheels[3].load;
    const outsideLoad = vehicle.wheels[0].load + vehicle.wheels[2].load;
    expect(outsideLoad).toBeGreaterThan(insideLoad);
  });

  it('dives onto its nose under braking', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 5, { forward: 1, turn: 0 });
    drive(vehicle, world, 0.3, { forward: 0, turn: 0, brake: true });
    const frontLoad = vehicle.wheels[0].load + vehicle.wheels[1].load;
    const rearLoad = vehicle.wheels[2].load + vehicle.wheels[3].load;
    expect(frontLoad).toBeGreaterThan(rearLoad);
  });

  it('rolls its wheels in proportion to how far it has travelled', () => {
    const { world, vehicle } = onGround();
    drive(vehicle, world, 3, { forward: 1, turn: 0 });
    const travelled = vehicle.chassis.position.z;
    // Roll is distance over radius; slip means it will be a little more, never far less.
    expect(vehicle.wheels[0].roll).toBeGreaterThan((travelled / CAR_WHEEL_RADIUS) * 0.8);
  });
});
