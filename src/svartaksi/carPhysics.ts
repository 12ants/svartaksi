/**
 * The player's car as a physical object: its chassis body, its four struts, and the
 * translation between what the keyboard asks for and what a car can actually do.
 *
 * Everything here is a number with a unit and a reason. The mass is a small hatchback's.
 * The spring rate is whatever puts the car 9cm down on its springs at rest, which is what
 * a road car sits at. The damping is a little under critical, because a car that returns
 * to level without a hint of overshoot reads as a trolley. The engine force tapers to
 * nothing at top speed, which is what stands in for a gearbox and aerodynamic drag
 * together and is why the car has a top speed at all rather than accelerating forever.
 *
 * The one deliberate departure from realism is the steering: lock is reduced as speed
 * rises. A real car's lock does not change, but a real driver's input is analogue and
 * theirs does. With a keyboard every input is full lock, and without this the car is
 * undriveable above thirty.
 */
import * as THREE from 'three';
import { createBody, type RigidBody } from '../physics/rigidBody';
import { createRaycastVehicle, type RaycastVehicle, type WheelSpec } from '../physics/vehicle';
import { box, CATEGORY_ALL, CATEGORY_CAR, collider } from '../physics/types';
import { CAR_HALF_TRACK, CAR_HALF_WHEELBASE, CAR_WHEEL_RADIUS, type CarModel } from './carModel';

/** Kerb weight, kg. A Saab 90 is 1080kg dry; this carries a driver and a tank of fuel. */
export const CAR_MASS = 1180;
/**
 * Height of the centre of mass above the road, in metres, and the offset between the
 * chassis *body* (which is placed at the centre of mass, because that is what a rigid
 * body rotates about) and the car *group* (whose origin sits on the road, because that is
 * where every other part of this game places it).
 */
export const CAR_COM_HEIGHT = 0.6;

/** Strut length at full extension, and how far it may travel either side of that. */
const SUSPENSION_REST = 0.39;
const SUSPENSION_TRAVEL = 0.14;
/** Where the strut is bolted on, measured from the centre of mass. */
const CONNECTION_HEIGHT = 0.12;
/** Spring rate: one corner carries a quarter of the car, and should sit ~9cm down. */
const SPRING_RATE = (CAR_MASS * 9.81 / 4) / 0.09;
/** Damping. Critical for a quarter-car here is about 2*sqrt(k*m) ≈ 6900 N·s/m; both
 * numbers sit under it, rebound harder than compression, as a real damper is valved. */
const DAMPING_COMPRESSION = 3400;
const DAMPING_REBOUND = 5200;
/** Ceiling on any one strut, so a wheel dropped into a hole cannot launch the car. */
const MAX_SUSPENSION_FORCE = 26_000;

export const CAR_MAX_STEER = 0.55;
const ENGINE_FORCE = 11_000;
const REVERSE_FORCE = 4_400;
const BRAKE_FORCE = 22_000;
/** Drag from lifting off: enough to slow the car noticeably without it feeling towed. */
const ENGINE_BRAKING = 900;
const TOP_SPEED = 26;
const REVERSE_TOP_SPEED = 8;
/** What the boost key is worth. Kept as a multiple of the ordinary figures so the car
 * still behaves like a car when it is used, just a far more powerful one. */
const BOOST_ENGINE_MULTIPLIER = 5;
const BOOST_TOP_SPEED = 150;
/** Quadratic drag coefficient, N per (m/s)^2: 0.5 * Cd * A * rho for a small hatchback. */
const DRAG_COEFFICIENT = 0.42;

function wheelSpec(x: number, z: number, front: boolean): WheelSpec {
  return {
    connection: new THREE.Vector3(x, CONNECTION_HEIGHT, z),
    radius: CAR_WHEEL_RADIUS,
    suspensionRest: SUSPENSION_REST,
    stiffness: SPRING_RATE,
    dampingCompression: DAMPING_COMPRESSION,
    dampingRebound: DAMPING_REBOUND,
    maxTravel: SUSPENSION_TRAVEL,
    maxForce: MAX_SUSPENSION_FORCE,
    steered: front,
    // All four driven. Rear drive is more fun with a wheel and considerably worse with
    // four keys, where there is no way to catch a slide you did not ask for.
    driven: true,
    // Weight transfers forward under braking, so the fronts can use more of the effort.
    brakeShare: front ? 0.32 : 0.18,
    // A touch more grip at the front than the rear, which makes the car understeer at
    // the limit rather than spin: the forgiving failure mode.
    grip: front ? 1.7 : 1.55,
    rollInfluence: 0.25,
  };
}

/**
 * The chassis body and its vehicle. The colliders are the body shell and the cabin, which
 * is what actually strikes things — the wheels are rays, not shapes, and never collide.
 */
export function createCarVehicle(): RaycastVehicle {
  const chassis = createBody({
    id: 'vehicle:car',
    mass: CAR_MASS,
    colliders: [
      // Both boxes are the Saab's own measured envelope (SAAB_DIMENSIONS): 1.98m across,
      // 4.92m long, 1.55m tall, expressed here as half-extents about the centre of mass.
      // The lower box is the sills-to-waistline mass of the car; the upper is the
      // greenhouse, narrower and set back over the rear seats as a saloon's is.
      collider(box(0.95, 0.35, 2.4), new THREE.Vector3(0, 0.05, 0)),
      collider(box(0.8, 0.25, 1.05), new THREE.Vector3(0, 0.65, -0.2)),
    ],
    friction: 0.4,
    restitution: 0.15,
    // Air drag is applied explicitly (see applyCarControls); the linear damping here is
    // only what keeps a stationary car from creeping on solver noise.
    linearDamping: 0.05,
    angularDamping: 1.2,
    // The player's car must respond on the tick the key is pressed, however long it has
    // been parked.
    neverSleep: true,
    userData: { kind: 'car', category: CATEGORY_CAR, mask: CATEGORY_ALL },
  });
  return createRaycastVehicle({
    chassis,
    wheels: [
      wheelSpec(-CAR_HALF_TRACK, CAR_HALF_WHEELBASE, true),
      wheelSpec(CAR_HALF_TRACK, CAR_HALF_WHEELBASE, true),
      wheelSpec(-CAR_HALF_TRACK, -CAR_HALF_WHEELBASE, false),
      wheelSpec(CAR_HALF_TRACK, -CAR_HALF_WHEELBASE, false),
    ],
    steerRate: 3.4,
  });
}

export interface CarControls {
  /** -1..1; positive is forward. */
  forward: number;
  /** -1..1; positive turns left, matching this world's +y-is-counterclockwise yaw. */
  turn: number;
  brake: boolean;
  boost: boolean;
}

/**
 * Translates one tick of input into engine, brake and steering demands, and applies the
 * aerodynamic drag that gives the car a top speed. Pure bookkeeping on the vehicle — the
 * physics of it happens in `RaycastVehicle.update`.
 */
export function applyCarControls(vehicle: RaycastVehicle, input: CarControls, dt: number): void {
  const speed = vehicle.forwardSpeed();
  const absSpeed = Math.abs(speed);

  // Lock falls away with speed. See the file comment for why this is here at all.
  const steerLimit = CAR_MAX_STEER * (0.34 + 0.66 / (1 + absSpeed / 15));
  vehicle.setSteering(input.turn * steerLimit);

  const throttle = input.brake ? 0 : input.forward;
  const boost = input.boost ? BOOST_ENGINE_MULTIPLIER : 1;
  const topSpeed = input.boost ? BOOST_TOP_SPEED : TOP_SPEED;
  let engine = 0;
  if (throttle > 0) {
    engine = throttle * ENGINE_FORCE * boost * Math.max(0, 1 - Math.max(0, speed) / topSpeed);
  } else if (throttle < 0) {
    engine = throttle * REVERSE_FORCE * Math.max(0, 1 - Math.max(0, -speed) / REVERSE_TOP_SPEED);
  }
  vehicle.setEngineForce(engine);
  vehicle.setBrake(input.brake ? BRAKE_FORCE : throttle === 0 ? ENGINE_BRAKING : 0);

  // Drag rises with the square of speed, which is what keeps the top speed finite and
  // makes the last few km/h take far longer to find than the first.
  const chassis = vehicle.chassis;
  const velocity = chassis.linearVelocity;
  const magnitude = velocity.length();
  if (magnitude > 0.01) {
    const drag = DRAG_COEFFICIENT * magnitude * magnitude;
    velocity.addScaledVector(velocity, -(drag * dt) / (magnitude * CAR_MASS));
  }
}

/**
 * Places the rendered car on its physics chassis. The group's origin is on the road while
 * the body's is at the centre of mass,
 * so the group is offset down by exactly that — through the chassis's own rotation, which
 * is what makes the car lean about its centre of mass rather than about a point on the
 * tarmac under it.
 */
export function syncCarPose(model: CarModel, vehicle: RaycastVehicle): void {
  const chassis = vehicle.chassis;
  model.group.quaternion.copy(chassis.quaternion);
  model.group.position.copy(chassis.position)
    .add(_comOffset.set(0, -CAR_COM_HEIGHT, 0).applyQuaternion(chassis.quaternion));
}

/**
 * Places each wheel where its own strut has ended up. Split from the pose above because
 * a parked car still stands on its springs: when the player is on foot or aboard the bus
 * the body stays exactly where it was left, but the wheels are still resolved against
 * whatever ground is under them.
 */
export function syncCarWheels(model: CarModel, vehicle: RaycastVehicle): void {
  for (let index = 0; index < model.wheels.length; index += 1) {
    const wheel = vehicle.wheels[index];
    if (!wheel) continue;
    const hub = model.wheels[index];
    hub.position.y = wheel.spec.connection.y - wheel.suspensionLength + CAR_COM_HEIGHT;
    hub.quaternion.setFromAxisAngle(_up, wheel.steer)
      .multiply(_roll.setFromAxisAngle(_right, wheel.roll));
  }
}

/**
 * Puts the chassis where the car group is, at rest. Used whenever something outside the
 * simulation moves the car — a teleport, a spawn, being set down beside the bus — and on
 * every tick the player is not actually driving, so the physics car can never drift away
 * from the one the rest of the game thinks it has parked.
 */
export function syncCarBodyFromGroup(vehicle: RaycastVehicle, group: THREE.Object3D): void {
  const chassis: RigidBody = vehicle.chassis;
  chassis.quaternion.setFromAxisAngle(_up, group.rotation.y);
  chassis.position.copy(group.position)
    .add(_comOffset.set(0, CAR_COM_HEIGHT, 0).applyQuaternion(chassis.quaternion));
  chassis.linearVelocity.set(0, 0, 0);
  chassis.angularVelocity.set(0, 0, 0);
  vehicle.setEngineForce(0);
  vehicle.setBrake(0);
  vehicle.setSteering(0);
}

const _comOffset = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);
const _roll = new THREE.Quaternion();
