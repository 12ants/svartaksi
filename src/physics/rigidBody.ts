/**
 * A rigid body: where a thing is, how it is turned, how fast it is doing both, and how
 * hard it is to change any of that.
 *
 * Bodies here are either `static` (infinite mass — the ground, a lamp post nobody has
 * hit yet) or `dynamic`. Promotion from one to the other at runtime is the whole point
 * of the prop layer: street furniture stands as static geometry until something hits it
 * hard enough, at which moment it becomes a dynamic body mid-simulation and falls over.
 * See `setBodyDynamic`.
 *
 * Inertia is kept as a diagonal tensor in body space and rotated into world space each
 * step. That is exact for a single box or sphere centred on its body's origin, and an
 * approximation for a compound whose parts are offset or turned relative to each other —
 * the parallel-axis terms are summed but the products of inertia are dropped. For a
 * signal head (a pole with a box on top, all sharing one vertical axis) the dropped terms
 * are zero anyway; for anything less tidy the error shows up as a topple that tumbles
 * slightly more evenly than it should, which is not a difference anyone watching a lamp
 * post fall over can name.
 */
import * as THREE from 'three';
import { colliderAabb, emptyAabb, expandAabb, type Aabb, type Collider } from './types';

export type BodyType = 'static' | 'dynamic';

export interface RigidBody {
  id: string;
  type: BodyType;
  colliders: Collider[];

  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  linearVelocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;

  mass: number;
  invMass: number;
  /** Diagonal of the inverse inertia tensor in body space. */
  invInertiaLocal: THREE.Vector3;
  /** The same tensor rotated into world space; refreshed by `updateBodyDerived`. */
  invInertiaWorld: THREE.Matrix3;

  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  /** Below this speed the body may fall asleep; see `updateSleep`. */
  sleeping: boolean;
  sleepTimer: number;
  /** Bodies that never sleep — the player's vehicle, which must respond to input on the
   * very next tick however long it has been standing still. */
  neverSleep: boolean;

  aabb: Aabb;
  /** Whatever the owner needs to find its way back from a contact to its own model. */
  userData: Record<string, unknown>;
}

export interface BodyOptions {
  id: string;
  type?: BodyType;
  colliders: Collider[];
  mass?: number;
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  restitution?: number;
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  neverSleep?: boolean;
  userData?: Record<string, unknown>;
}

/** Volume of a collider's shape, used to split a body's mass between its parts. */
export function colliderVolume(item: Collider): number {
  if (item.shape.kind === 'sphere') return (4 / 3) * Math.PI * item.shape.radius ** 3;
  const e = item.shape.halfExtents;
  return 8 * e.x * e.y * e.z;
}

/**
 * Diagonal inertia tensor for a compound of colliders totalling `mass`, about the body's
 * own origin. Mass is split between parts by volume — a uniform-density solid, which is
 * the right model for the poles and posts this is used on.
 */
export function computeInertia(colliders: Collider[], mass: number): THREE.Vector3 {
  const inertia = new THREE.Vector3();
  if (mass <= 0 || !colliders.length) return inertia;
  let totalVolume = 0;
  for (const item of colliders) totalVolume += colliderVolume(item);
  if (totalVolume <= 0) return inertia;

  for (const item of colliders) {
    const share = mass * (colliderVolume(item) / totalVolume);
    if (item.shape.kind === 'sphere') {
      const own = (2 / 5) * share * item.shape.radius ** 2;
      inertia.x += own;
      inertia.y += own;
      inertia.z += own;
    } else {
      const e = item.shape.halfExtents;
      const w = (2 * e.x) ** 2;
      const h = (2 * e.y) ** 2;
      const d = (2 * e.z) ** 2;
      inertia.x += (share / 12) * (h + d);
      inertia.y += (share / 12) * (w + d);
      inertia.z += (share / 12) * (w + h);
    }
    // Parallel axis: an offset part resists rotation about the body origin by its own
    // inertia plus m*r^2 measured perpendicular to each axis. This is what makes a
    // signal housing three metres up the pole dominate how the whole thing topples.
    const o = item.offset;
    inertia.x += share * (o.y * o.y + o.z * o.z);
    inertia.y += share * (o.x * o.x + o.z * o.z);
    inertia.z += share * (o.x * o.x + o.y * o.y);
  }
  return inertia;
}

export function createBody(options: BodyOptions): RigidBody {
  const type = options.type ?? 'dynamic';
  const mass = type === 'static' ? 0 : Math.max(1e-3, options.mass ?? 1);
  const inertia = type === 'static'
    ? new THREE.Vector3()
    : computeInertia(options.colliders, mass);
  const body: RigidBody = {
    id: options.id,
    type,
    colliders: options.colliders,
    position: options.position?.clone() ?? new THREE.Vector3(),
    quaternion: options.quaternion?.clone() ?? new THREE.Quaternion(),
    linearVelocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    mass: type === 'static' ? 0 : mass,
    invMass: type === 'static' ? 0 : 1 / mass,
    invInertiaLocal: new THREE.Vector3(
      inertia.x > 0 ? 1 / inertia.x : 0,
      inertia.y > 0 ? 1 / inertia.y : 0,
      inertia.z > 0 ? 1 / inertia.z : 0,
    ),
    invInertiaWorld: new THREE.Matrix3(),
    restitution: options.restitution ?? 0.05,
    friction: options.friction ?? 0.7,
    linearDamping: options.linearDamping ?? 0.02,
    angularDamping: options.angularDamping ?? 0.08,
    sleeping: false,
    sleepTimer: 0,
    neverSleep: options.neverSleep ?? false,
    aabb: emptyAabb(),
    userData: options.userData ?? {},
  };
  updateBodyDerived(body);
  return body;
}

/**
 * Turns a static body dynamic in place, keeping its pose. Used when something hits a
 * piece of street furniture hard enough to tear it out of the pavement — up to that
 * moment it costs a static body's near-nothing, and only the ones actually knocked over
 * ever join the dynamic set.
 */
export function setBodyDynamic(body: RigidBody, mass: number): void {
  if (body.type === 'dynamic') return;
  const safeMass = Math.max(1e-3, mass);
  const inertia = computeInertia(body.colliders, safeMass);
  body.type = 'dynamic';
  body.mass = safeMass;
  body.invMass = 1 / safeMass;
  body.invInertiaLocal.set(
    inertia.x > 0 ? 1 / inertia.x : 0,
    inertia.y > 0 ? 1 / inertia.y : 0,
    inertia.z > 0 ? 1 / inertia.z : 0,
  );
  body.sleeping = false;
  body.sleepTimer = 0;
  updateBodyDerived(body);
}

/** Rotates the inverse inertia tensor into world space and refreshes the body's bounds. */
export function updateBodyDerived(body: RigidBody): void {
  _basis.makeRotationFromQuaternion(body.quaternion);
  const m = _basis.elements;
  const ix = body.invInertiaLocal.x;
  const iy = body.invInertiaLocal.y;
  const iz = body.invInertiaLocal.z;
  // R * diag(i) * R^T, written out: column k of R scaled by i_k, then times R^T.
  const e = body.invInertiaWorld.elements;
  e[0] = m[0] * ix * m[0] + m[4] * iy * m[4] + m[8] * iz * m[8];
  e[1] = m[1] * ix * m[0] + m[5] * iy * m[4] + m[9] * iz * m[8];
  e[2] = m[2] * ix * m[0] + m[6] * iy * m[4] + m[10] * iz * m[8];
  e[3] = m[0] * ix * m[1] + m[4] * iy * m[5] + m[8] * iz * m[9];
  e[4] = m[1] * ix * m[1] + m[5] * iy * m[5] + m[9] * iz * m[9];
  e[5] = m[2] * ix * m[1] + m[6] * iy * m[5] + m[10] * iz * m[9];
  e[6] = m[0] * ix * m[2] + m[4] * iy * m[6] + m[8] * iz * m[10];
  e[7] = m[1] * ix * m[2] + m[5] * iy * m[6] + m[9] * iz * m[10];
  e[8] = m[2] * ix * m[2] + m[6] * iy * m[6] + m[10] * iz * m[10];
  updateBodyAabb(body);
}

export function updateBodyAabb(body: RigidBody): void {
  body.aabb.min.set(Infinity, Infinity, Infinity);
  body.aabb.max.set(-Infinity, -Infinity, -Infinity);
  for (const item of body.colliders) {
    colliderAabb(item, body.position, body.quaternion, _scratch);
    expandAabb(body.aabb, _scratch);
  }
}

/** World-space velocity of the material point currently at `worldPoint`. */
export function pointVelocity(body: RigidBody, worldPoint: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  _arm.copy(worldPoint).sub(body.position);
  return target.copy(body.angularVelocity).cross(_arm).add(body.linearVelocity);
}

/** Applies `impulse` (N·s) at a world point, changing both linear and angular velocity. */
export function applyImpulse(body: RigidBody, impulse: THREE.Vector3, worldPoint: THREE.Vector3): void {
  if (body.invMass === 0) return;
  wakeBody(body);
  body.linearVelocity.addScaledVector(impulse, body.invMass);
  _arm.copy(worldPoint).sub(body.position).cross(impulse).applyMatrix3(body.invInertiaWorld);
  body.angularVelocity.add(_arm);
}


export function wakeBody(body: RigidBody): void {
  if (body.type === 'static') return;
  body.sleeping = false;
  body.sleepTimer = 0;
}

export function integrateVelocity(body: RigidBody, gravity: THREE.Vector3, dt: number): void {
  if (body.type === 'static' || body.sleeping) return;
  body.linearVelocity.addScaledVector(gravity, dt);
  // Exponential damping so the decay is frame-rate independent rather than "multiply by
  // 0.98 per tick", which means something different at every tick rate.
  body.linearVelocity.multiplyScalar(Math.exp(-body.linearDamping * dt));
  body.angularVelocity.multiplyScalar(Math.exp(-body.angularDamping * dt));
}

export function integratePosition(body: RigidBody, dt: number): void {
  if (body.type === 'static' || body.sleeping) return;
  body.position.addScaledVector(body.linearVelocity, dt);
  const w = body.angularVelocity;
  // q' = q + 0.5 * omega_quat * q * dt, renormalised — the standard first-order
  // quaternion integration, accurate enough at a 60Hz tick for spin rates this world
  // produces (a toppling post turns well under one revolution a second).
  _spin.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
  _spin.multiply(body.quaternion);
  body.quaternion.set(
    body.quaternion.x + _spin.x,
    body.quaternion.y + _spin.y,
    body.quaternion.z + _spin.z,
    body.quaternion.w + _spin.w,
  ).normalize();
  updateBodyDerived(body);
}

/** Speeds under which a body is a candidate for sleeping, and for how long. */
export const SLEEP_LINEAR_SPEED = 0.12;
export const SLEEP_ANGULAR_SPEED = 0.16;
export const SLEEP_DELAY = 0.7;

/**
 * Puts a body that has stopped moving to sleep so the solver can skip it. A knocked-over
 * post ends up lying still on the pavement for the rest of the session; without this it
 * would keep costing contact solving forever, and with a hundred of them that is the
 * difference between a physics budget that is free and one that is not.
 */
export function updateSleep(body: RigidBody, dt: number): void {
  if (body.type === 'static' || body.neverSleep) return;
  const slow = body.linearVelocity.lengthSq() < SLEEP_LINEAR_SPEED ** 2
    && body.angularVelocity.lengthSq() < SLEEP_ANGULAR_SPEED ** 2;
  if (!slow) {
    body.sleepTimer = 0;
    body.sleeping = false;
    return;
  }
  body.sleepTimer += dt;
  if (body.sleepTimer >= SLEEP_DELAY && !body.sleeping) {
    body.sleeping = true;
    body.linearVelocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
  }
}

const _basis = new THREE.Matrix4();
const _scratch = emptyAabb();
const _arm = new THREE.Vector3();
const _spin = new THREE.Quaternion();
