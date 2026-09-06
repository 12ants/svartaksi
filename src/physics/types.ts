/**
 * The vocabulary the physics engine is built out of: collision shapes, colliders, and
 * the axis-aligned bounds every broadphase and raycast reasons about.
 *
 * Deliberately only two primitives. A box (as an oriented box — colliders carry their
 * own rotation) covers everything this world stands up: lamp posts, signal heads, tree
 * trunks, post boxes, shelter frames, vehicle chassis. A sphere covers the round,
 * light things (a wheel probe, a person, debris). Capsules and convex hulls would each
 * add a whole family of narrowphase cases for shapes nothing here actually is, and the
 * only thing that suffers from a box-shaped tree trunk is the exact moment of contact
 * on a glancing blow.
 */
import * as THREE from 'three';

export interface BoxShape {
  kind: 'box';
  /** Half the extent along each local axis, so a 0.2m lamp post is (0.1, 2.3, 0.1). */
  halfExtents: THREE.Vector3;
}

export interface SphereShape {
  kind: 'sphere';
  radius: number;
}

export type ColliderShape = BoxShape | SphereShape;

/**
 * One shape, placed in its body's frame. A body can carry several — a traffic signal is
 * a tall thin pole plus a housing hung off the top of it, and that pair is what gives it
 * the top-heavy feel that decides how it falls.
 */
export interface Collider {
  shape: ColliderShape;
  /** Centre of the shape in body space. */
  offset: THREE.Vector3;
  /** Orientation of the shape in body space. Identity for everything axis-aligned. */
  rotation: THREE.Quaternion;
}

export interface Aabb {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export function box(halfX: number, halfY: number, halfZ: number): BoxShape {
  return { kind: 'box', halfExtents: new THREE.Vector3(halfX, halfY, halfZ) };
}

export function sphere(radius: number): SphereShape {
  return { kind: 'sphere', radius };
}

/** A collider at the body's own origin, unrotated — the common case. */
export function collider(
  shape: ColliderShape,
  offset: THREE.Vector3 = new THREE.Vector3(),
  rotation: THREE.Quaternion = new THREE.Quaternion(),
): Collider {
  return { shape, offset, rotation };
}

export function emptyAabb(): Aabb {
  return {
    min: new THREE.Vector3(Infinity, Infinity, Infinity),
    max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
  };
}

export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x
    && a.min.y <= b.max.y && a.max.y >= b.min.y
    && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/**
 * World-space bounds of one collider on a body at `position`/`quaternion`.
 *
 * A rotated box's bounds are found by projecting its three (scaled) axes onto each world
 * axis and summing the absolute contributions — the standard result that the extent of a
 * rotated box along an axis is the sum of |axis · localAxis_i| * halfExtent_i.
 */
/** Where a collider's own centre sits in the world, given the body it is bolted to.
 * Written into `target` so the callers that ask for it every tick — contact generation,
 * both raycasts, the AABB above — do not each allocate one. */
export function colliderCentre(
  item: Collider,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  target: THREE.Vector3,
): THREE.Vector3 {
  return target.copy(item.offset).applyQuaternion(quaternion).add(position);
}

export function colliderAabb(
  item: Collider,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  target: Aabb,
): Aabb {
  const centre = colliderCentre(item, position, quaternion, _centre);
  if (item.shape.kind === 'sphere') {
    const r = item.shape.radius;
    target.min.set(centre.x - r, centre.y - r, centre.z - r);
    target.max.set(centre.x + r, centre.y + r, centre.z + r);
    return target;
  }
  const orientation = _orientation.copy(quaternion).multiply(item.rotation);
  _basis.makeRotationFromQuaternion(orientation);
  const e = item.shape.halfExtents;
  const m = _basis.elements;
  const extentX = Math.abs(m[0]) * e.x + Math.abs(m[4]) * e.y + Math.abs(m[8]) * e.z;
  const extentY = Math.abs(m[1]) * e.x + Math.abs(m[5]) * e.y + Math.abs(m[9]) * e.z;
  const extentZ = Math.abs(m[2]) * e.x + Math.abs(m[6]) * e.y + Math.abs(m[10]) * e.z;
  target.min.set(centre.x - extentX, centre.y - extentY, centre.z - extentZ);
  target.max.set(centre.x + extentX, centre.y + extentY, centre.z + extentZ);
  return target;
}

/**
 * Collision categories (backlog item 4). A body's `userData.category` is what it *is*;
 * its `userData.mask` is what it is willing to be solved against. Two bodies collide only
 * when each one's category is present in the other's mask — the standard two-way check,
 * so a filter has to be agreed by both sides rather than imposed by either alone.
 *
 * Bodies that never set `userData.category`/`userData.mask` (every body this world built
 * before this item existed — the ground, street furniture already in flight) fall back to
 * `CATEGORY_ALL`/`MASK_ALL` in `bodiesCanCollide`, so adding the check does not change who
 * collides with whom until a body actually opts into a narrower category.
 */
export const CATEGORY_CAR = 1 << 0;
export const CATEGORY_PILL = 1 << 1;
export const CATEGORY_BUS = 1 << 2;
export const CATEGORY_PROPS = 1 << 3;
export const CATEGORY_BUILDINGS = 1 << 4;
/** Not a physical body category — a raycast (the debug picker, inspection) can pass this
 * in its own mask to admit only what the debug view itself draws. */
export const CATEGORY_DEBUG = 1 << 5;
export const CATEGORY_ALL = 0xffff;
export const MASK_ALL = CATEGORY_ALL;

/** A body's collision category, defaulting to `CATEGORY_ALL` when unset. */
export function bodyCategory(userData: Record<string, unknown>): number {
  const value = userData.category;
  return typeof value === 'number' ? value : CATEGORY_ALL;
}

/** A body's collision mask, defaulting to `MASK_ALL` when unset. */
export function bodyMask(userData: Record<string, unknown>): number {
  const value = userData.mask;
  return typeof value === 'number' ? value : MASK_ALL;
}

/** Two-way category/mask test: each body's category must be admitted by the other's
 * mask. Symmetric, so it does not matter which body is passed first. */
export function categoriesInteract(
  aData: Record<string, unknown>,
  bData: Record<string, unknown>,
): boolean {
  return (bodyCategory(aData) & bodyMask(bData)) !== 0
    && (bodyCategory(bData) & bodyMask(aData)) !== 0;
}

export function expandAabb(target: Aabb, other: Aabb): void {
  target.min.min(other.min);
  target.max.max(other.max);
}

const _centre = new THREE.Vector3();
const _orientation = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
