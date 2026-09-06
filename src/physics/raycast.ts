/**
 * Ray casting against collider shapes. The vehicle's wheels are the main customer: each
 * one is a ray dropped from its mounting point, and where that ray lands is the whole of
 * what the suspension knows about the ground.
 */
import * as THREE from 'three';
import type { RigidBody } from './rigidBody';
import { colliderCentre } from './types';
import type { Aabb, BoxShape, Collider, SphereShape } from './types';

export interface RayHit {
  body: RigidBody;
  /** Distance along the ray direction, which is assumed to be a unit vector. */
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Slab test in the box's own frame. Returns the entry distance, or null when the ray
 * misses or only touches behind its origin. The normal is the face the entry happened
 * on, rotated back into world space.
 */
export function raycastBox(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  item: Collider,
  shape: BoxShape,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): { distance: number; normal: THREE.Vector3 } | null {
  const orientation = _orientation.copy(quaternion).multiply(item.rotation);
  const inverse = _inverse.copy(orientation).invert();
  const centre = colliderCentre(item, position, quaternion, _centre);
  const localOrigin = _localOrigin.copy(origin).sub(centre).applyQuaternion(inverse);
  const localDirection = _localDirection.copy(direction).applyQuaternion(inverse);

  const e = [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z];
  const o = [localOrigin.x, localOrigin.y, localOrigin.z];
  const d = [localDirection.x, localDirection.y, localDirection.z];

  let near = -Infinity;
  let far = Infinity;
  let axis = 0;
  let sign = 1;
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < -e[i] || o[i] > e[i]) return null;
      continue;
    }
    let t1 = (-e[i] - o[i]) / d[i];
    let t2 = (e[i] - o[i]) / d[i];
    let faceSign = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      faceSign = 1;
    }
    if (t1 > near) {
      near = t1;
      axis = i;
      sign = faceSign;
    }
    if (t2 < far) far = t2;
    if (near > far) return null;
  }
  const distance = near >= 0 ? near : far;
  if (distance < 0 || distance > maxDistance) return null;

  const normal = _normal.set(0, 0, 0);
  normal.setComponent(axis, sign);
  return { distance, normal: normal.clone().applyQuaternion(orientation) };
}

export function raycastSphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  item: Collider,
  shape: SphereShape,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): { distance: number; normal: THREE.Vector3 } | null {
  const centre = colliderCentre(item, position, quaternion, _centre);
  const toCentre = _localOrigin.copy(centre).sub(origin);
  const along = toCentre.dot(direction);
  const distanceSq = toCentre.lengthSq() - along * along;
  const radiusSq = shape.radius * shape.radius;
  if (distanceSq > radiusSq) return null;
  const half = Math.sqrt(radiusSq - distanceSq);
  const distance = along - half >= 0 ? along - half : along + half;
  if (distance < 0 || distance > maxDistance) return null;
  const point = _normal.copy(direction).multiplyScalar(distance).add(origin);
  return { distance, normal: point.sub(centre).normalize().clone() };
}

/**
 * Slab test of a ray against a body's world AABB — a cheap reject before the real
 * per-collider maths. The AABB is already maintained on every body (updateBodyDerived),
 * and a wheel's 70cm plumb ray misses almost everything in the world, so this is what
 * keeps a raycast over hundreds of prop bodies to a handful of comparisons each.
 */
export function rayHitsAabb(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  aabb: Aabb,
): boolean {
  let near = 0;
  let far = maxDistance;
  for (const axis of AXES) {
    const start = origin[axis];
    const step = direction[axis];
    if (Math.abs(step) < 1e-8) {
      if (start < aabb.min[axis] || start > aabb.max[axis]) return false;
      continue;
    }
    const inverse = 1 / step;
    let entry = (aabb.min[axis] - start) * inverse;
    let exit = (aabb.max[axis] - start) * inverse;
    if (entry > exit) [entry, exit] = [exit, entry];
    if (entry > near) near = entry;
    if (exit < far) far = exit;
    if (near > far) return false;
  }
  return true;
}

const AXES = ['x', 'y', 'z'] as const;

/** Nearest hit on one body, or null. */
export function raycastBody(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  body: RigidBody,
): RayHit | null {
  if (!rayHitsAabb(origin, direction, maxDistance, body.aabb)) return null;
  let best: RayHit | null = null;
  for (const item of body.colliders) {
    const hit = item.shape.kind === 'box'
      ? raycastBox(origin, direction, maxDistance, item, item.shape, body.position, body.quaternion)
      : raycastSphere(origin, direction, maxDistance, item, item.shape, body.position, body.quaternion);
    if (!hit) continue;
    if (best && hit.distance >= best.distance) continue;
    best = {
      body,
      distance: hit.distance,
      point: direction.clone().multiplyScalar(hit.distance).add(origin),
      normal: hit.normal,
    };
  }
  return best;
}

const _orientation = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();
const _centre = new THREE.Vector3();
const _localOrigin = new THREE.Vector3();
const _localDirection = new THREE.Vector3();
const _normal = new THREE.Vector3();
