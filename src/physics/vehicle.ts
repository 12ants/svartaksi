/**
 * A raycast vehicle: a rigid chassis carried on four independent spring/damper struts,
 * each of which finds the ground by casting a ray straight down from where it is bolted
 * to the body.
 *
 * This is the model every driving game that isn't a simulator uses, and it is the right
 * one here. Simulating a wheel as an actual rolling cylinder means solving a rolling
 * contact that is stiff, sensitive to tick rate, and prone to letting a fast car tunnel
 * through the road; a ray finds the surface exactly, at any speed, for the cost of one
 * cast per wheel per tick. Everything that makes a car feel like a car — the nose diving
 * under braking, the body leaning through a corner, one wheel dropping into a gutter and
 * the far corner unloading — falls out of four struts pushing on a rigid body at four
 * different points, without any of it being animated.
 *
 * Two forces act at each contact patch:
 *
 * - **Suspension**, along the contact normal: a spring proportional to how far the strut
 *   is compressed, plus a damper proportional to how fast that is changing. The damper is
 *   what stops the car pogoing; without it a spring alone stores and returns the energy of
 *   every bump forever.
 * - **Tyre friction**, in the contact plane, split into the direction the wheel is
 *   pointing and the direction it is not. Both are limited by the load the suspension is
 *   carrying at that instant — which is why lifting off mid-corner reduces the grip at
 *   the rear, and why a wheel in the air has none at all.
 */
import * as THREE from 'three';
import { pointVelocity, wakeBody, type RigidBody } from './rigidBody';
import type { RayHit } from './raycast';

export interface WheelSpec {
  /** Where the strut is bolted to the chassis, in chassis space, at full extension. */
  connection: THREE.Vector3;
  radius: number;
  /** Strut length at rest, from the connection point to the wheel centre. */
  suspensionRest: number;
  /** Spring rate in newtons per metre of compression. */
  stiffness: number;
  /** Damper rate in newton-seconds per metre. Compression and rebound are damped
   * separately: real dampers resist rebound harder, which is what keeps a car settled
   * over a crest instead of throwing it. */
  dampingCompression: number;
  dampingRebound: number;
  /** How far the strut may travel either side of rest before it tops or bottoms out. */
  maxTravel: number;
  /** Ceiling on the suspension force, so a deeply compressed strut cannot fire the car. */
  maxForce: number;
  steered: boolean;
  driven: boolean;
  /** Share of the braking effort this wheel takes, 0..1. Fronts take more, as they do
   * on any car, because the weight transfers onto them. */
  brakeShare: number;
  /** Peak lateral grip as a multiple of the load the strut is carrying. */
  grip: number;
  /**
   * 0..1: how much of the lateral tyre force is allowed to roll the body.
   *
   * Applying friction at the contact patch — a wheel radius below the centre of mass —
   * is physically what happens and is what generates body roll, but at full strength it
   * also lets a hard corner lift the inside wheels and flip the car. Real vehicles resist
   * that through anti-roll bars, which is what this number stands in for.
   */
  rollInfluence: number;
}

export interface Wheel {
  spec: WheelSpec;
  /** Current strut length, connection point to wheel centre. */
  suspensionLength: number;
  /** True while this wheel's ray found ground within its travel. */
  grounded: boolean;
  contactPoint: THREE.Vector3;
  contactNormal: THREE.Vector3;
  /** The body the wheel is standing on, when it is not the ground itself. */
  contactBody: RigidBody | null;
  /** Newtons the strut is currently carrying. Zero in the air. */
  load: number;
  /** Steering angle actually reached, after rate limiting. */
  steer: number;
  /** Accumulated roll angle, for spinning the wheel mesh. */
  roll: number;
  /** Speed of the contact patch along the wheel's own heading, m/s. */
  forwardSpeed: number;
  /** Lateral slip speed at the contact patch, m/s — how hard the tyre is scrubbing. */
  slipSpeed: number;
  /** World position of the wheel centre, refreshed each update for rendering. */
  centre: THREE.Vector3;
}

export type CastRay = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  ignore: RigidBody,
) => RayHit | null;

export interface RaycastVehicle {
  chassis: RigidBody;
  wheels: Wheel[];
  /** Target steering angle in radians; the wheels turn towards it at `steerRate`. */
  setSteering(radians: number): void;
  /** Total drive force in newtons, split between the driven wheels. */
  setEngineForce(newtons: number): void;
  /** Total brake force in newtons, split by each wheel's `brakeShare`. */
  setBrake(newtons: number): void;
  /** Locks the wheels — a separate control from the brake, used for the handbrake. */
  setHandbrake(engaged: boolean): void;
  update(dt: number, castRay: CastRay): void;
  /** Chassis speed along its own forward axis, m/s. Signed: negative is reversing. */
  forwardSpeed(): number;
  /** Where and how the wheel mesh should be drawn this frame. */
  wheelTransform(index: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void;
}

export interface VehicleOptions {
  chassis: RigidBody;
  wheels: WheelSpec[];
  /** Radians per second the steering can be turned. Rate limiting is what stops a
   * keyboard's instant full lock from snapping the car sideways. */
  steerRate?: number;
}

export function createWheel(spec: WheelSpec): Wheel {
  return {
    spec,
    suspensionLength: spec.suspensionRest,
    grounded: false,
    contactPoint: new THREE.Vector3(),
    contactNormal: new THREE.Vector3(0, 1, 0),
    contactBody: null,
    load: 0,
    steer: 0,
    roll: 0,
    forwardSpeed: 0,
    slipSpeed: 0,
    centre: new THREE.Vector3(),
  };
}

/**
 * Effective mass of the chassis against an impulse along `direction` applied at
 * `worldPoint` — how much velocity change one newton-second buys there, accounting for
 * the rotation it also causes. The same quantity the contact solver computes; duplicated
 * here rather than shared because the vehicle only ever needs the one-body case.
 */
function effectiveMassAt(body: RigidBody, worldPoint: THREE.Vector3, direction: THREE.Vector3): number {
  if (body.invMass === 0) return 0;
  _arm.copy(worldPoint).sub(body.position);
  _angular.copy(_arm).cross(direction).applyMatrix3(body.invInertiaWorld).cross(_arm);
  return body.invMass + _angular.dot(direction);
}

function applyImpulseWithRollInfluence(
  body: RigidBody,
  impulse: THREE.Vector3,
  worldPoint: THREE.Vector3,
  rollInfluence: number,
): void {
  body.linearVelocity.addScaledVector(impulse, body.invMass);
  _arm.copy(worldPoint).sub(body.position);
  // Pulling the arm's vertical component in reduces the roll moment the lateral force
  // generates without touching the force itself — see WheelSpec.rollInfluence.
  _arm.y *= rollInfluence;
  _angular.copy(_arm).cross(impulse).applyMatrix3(body.invInertiaWorld);
  body.angularVelocity.add(_angular);
}

export function createRaycastVehicle(options: VehicleOptions): RaycastVehicle {
  const chassis = options.chassis;
  const wheels = options.wheels.map(createWheel);
  const steerRate = options.steerRate ?? 2.6;
  let steerTarget = 0;
  let engineForce = 0;
  let brakeForce = 0;
  let handbrake = false;

  const drivenCount = Math.max(1, wheels.filter((wheel) => wheel.spec.driven).length);

  const forwardSpeed = (): number => {
    _forward.set(0, 0, 1).applyQuaternion(chassis.quaternion);
    return chassis.linearVelocity.dot(_forward);
  };

  return {
    chassis,
    wheels,
    setSteering(radians) {
      steerTarget = radians;
    },
    setEngineForce(newtons) {
      engineForce = newtons;
    },
    setBrake(newtons) {
      brakeForce = Math.max(0, newtons);
    },
    setHandbrake(engaged) {
      handbrake = engaged;
    },
    forwardSpeed,
    update(dt, castRay) {
      if (dt <= 0) return;
      if (engineForce !== 0 || brakeForce !== 0 || steerTarget !== 0) wakeBody(chassis);

      const down = _down.set(0, -1, 0).applyQuaternion(chassis.quaternion).normalize();

      for (const wheel of wheels) {
        const spec = wheel.spec;
        wheel.steer = spec.steered
          ? THREE.MathUtils.clamp(
            wheel.steer + THREE.MathUtils.clamp(steerTarget - wheel.steer, -steerRate * dt, steerRate * dt),
            -Math.PI / 2,
            Math.PI / 2,
          )
          : 0;

        const connection = _connection.copy(spec.connection).applyQuaternion(chassis.quaternion).add(chassis.position);
        const reach = spec.suspensionRest + spec.maxTravel + spec.radius;
        const hit = castRay(connection, down, reach, chassis);

        const previousLength = wheel.suspensionLength;
        if (hit) {
          const restLength = THREE.MathUtils.clamp(
            hit.distance - spec.radius,
            spec.suspensionRest - spec.maxTravel,
            spec.suspensionRest + spec.maxTravel,
          );
          // The cast was only ever this long, so anything it found is within travel.
          wheel.grounded = true;
          wheel.suspensionLength = restLength;
          wheel.contactPoint.copy(hit.point);
          wheel.contactNormal.copy(hit.normal);
          wheel.contactBody = hit.body;
        } else {
          wheel.grounded = false;
          wheel.suspensionLength = spec.suspensionRest + spec.maxTravel;
          wheel.contactBody = null;
          wheel.contactNormal.set(0, 1, 0);
        }
        wheel.centre.copy(connection).addScaledVector(down, wheel.suspensionLength);

        if (!wheel.grounded) {
          wheel.load = 0;
          wheel.slipSpeed = 0;
          // A wheel in the air keeps turning, slowed only by its own bearings.
          wheel.roll += (wheel.forwardSpeed / spec.radius) * dt;
          wheel.forwardSpeed *= Math.exp(-0.8 * dt);
          continue;
        }

        const compression = spec.suspensionRest - wheel.suspensionLength;
        // Rate of change of strut length, positive while compressing.
        const compressionRate = (previousLength - wheel.suspensionLength) / dt;
        const damping = compressionRate > 0 ? spec.dampingCompression : spec.dampingRebound;
        const force = THREE.MathUtils.clamp(
          spec.stiffness * compression + damping * compressionRate,
          0,
          spec.maxForce,
        );
        wheel.load = force;
        _impulse.copy(wheel.contactNormal).multiplyScalar(force * dt);
        applyImpulseWithRollInfluence(chassis, _impulse, wheel.contactPoint, 1);
        // Newton's third law: a strut pushing the car up pushes the thing under it down.
        // That is what lets a heavy vehicle actually crush what it drives onto rather
        // than balancing on it weightlessly.
        if (hit && hit.body.type === 'dynamic') {
          hit.body.linearVelocity.addScaledVector(wheel.contactNormal, -force * dt * hit.body.invMass);
          wakeBody(hit.body);
        }
      }

      // Tyre forces are applied after every strut has been evaluated, so each wheel's
      // grip limit reflects the load distribution of this whole tick rather than a
      // half-updated one.
      for (const wheel of wheels) {
        const spec = wheel.spec;
        if (!wheel.grounded || wheel.load <= 0) continue;

        // The wheel's heading, then both tyre axes projected into the contact plane so
        // neither of them ever fights the suspension.
        _forward.set(0, 0, 1).applyQuaternion(chassis.quaternion).applyAxisAngle(wheel.contactNormal, wheel.steer);
        _forward.addScaledVector(wheel.contactNormal, -_forward.dot(wheel.contactNormal)).normalize();
        _side.copy(wheel.contactNormal).cross(_forward).normalize();

        pointVelocity(chassis, wheel.contactPoint, _velocity);
        if (wheel.contactBody && wheel.contactBody.type === 'dynamic') {
          pointVelocity(wheel.contactBody, wheel.contactPoint, _relative);
          _velocity.sub(_relative);
        }
        wheel.forwardSpeed = _velocity.dot(_forward);
        const lateralSpeed = _velocity.dot(_side);
        wheel.slipSpeed = Math.abs(lateralSpeed);
        wheel.roll += (wheel.forwardSpeed / spec.radius) * dt;

        // Coulomb limit for this tyre this tick: grip times the load the strut carries.
        const gripImpulse = spec.grip * wheel.load * dt;

        // Lateral: drive the sideways slip to zero, up to the grip limit. Past it the
        // tyre is sliding, and the vehicle slides with it.
        let lateralImpulse = 0;
        const lateralMass = effectiveMassAt(chassis, wheel.contactPoint, _side);
        if (lateralMass > 0) {
          const wanted = -lateralSpeed / lateralMass;
          lateralImpulse = THREE.MathUtils.clamp(wanted, -gripImpulse, gripImpulse);
          _impulse.copy(_side).multiplyScalar(lateralImpulse);
          applyImpulseWithRollInfluence(chassis, _impulse, wheel.contactPoint, spec.rollInfluence);
        }

        // Longitudinal: drive, then brake. Both share this tyre's one grip budget with
        // the lateral force above — whatever cornering has already spent is not available
        // to accelerate or brake with, which is why hard braking mid-corner washes the
        // front out and why a spinning wheel will not steer.
        const remaining = Math.max(0, gripImpulse - Math.abs(lateralImpulse));
        let longitudinal = spec.driven ? (engineForce / drivenCount) * dt : 0;
        const stopping = handbrake ? Number.POSITIVE_INFINITY : brakeForce * spec.brakeShare * dt;
        if (stopping > 0) {
          const longitudinalMass = effectiveMassAt(chassis, wheel.contactPoint, _forward);
          if (longitudinalMass > 0) {
            // Never more than what brings this contact patch to a standstill: braking
            // must not reverse the car.
            const toStandstill = -wheel.forwardSpeed / longitudinalMass;
            longitudinal += THREE.MathUtils.clamp(toStandstill, -stopping, stopping);
          }
        }
        longitudinal = THREE.MathUtils.clamp(longitudinal, -remaining, remaining);
        _impulse.copy(_forward).multiplyScalar(longitudinal);
        applyImpulseWithRollInfluence(chassis, _impulse, wheel.contactPoint, 1);

        if (wheel.contactBody && wheel.contactBody.type === 'dynamic') {
          // Whatever the tyre pushed against gets pushed back — a post under a wheel is
          // dragged along rather than politely ignored.
          _impulse.negate();
          wheel.contactBody.linearVelocity.addScaledVector(_impulse, wheel.contactBody.invMass);
          wakeBody(wheel.contactBody);
        }
      }
    },
    wheelTransform(index, position, quaternion) {
      const wheel = wheels[index];
      if (!wheel) return;
      position.copy(wheel.centre);
      quaternion.copy(chassis.quaternion)
        .multiply(_steerRotation.setFromAxisAngle(_up.set(0, 1, 0), wheel.steer))
        .multiply(_rollRotation.setFromAxisAngle(_right.set(1, 0, 0), wheel.roll));
    },
  };
}

const _arm = new THREE.Vector3();
const _angular = new THREE.Vector3();
const _down = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _side = new THREE.Vector3();
const _connection = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _steerRotation = new THREE.Quaternion();
const _rollRotation = new THREE.Quaternion();
