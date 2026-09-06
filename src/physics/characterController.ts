/**
 * On-foot collision for the pill/blob: a small sphere probe swept against the same
 * static colliders buildings/props already register with the world (buildingLayer.ts,
 * propLayer.ts), resolved by iterative de-penetration rather than the full velocity
 * solver — a walking character needs its position corrected directly, not nudged by an
 * impulse that only shows up next tick.
 *
 * Deliberately not routed through `PhysicsWorld.step`'s own broadphase/solver: the pill
 * is a positionally-driven body (see `carryDrivenBody` in svartaksiRuntime.tsx) whose pose
 * is overwritten from the model every tick, so any velocity-based correction the solver
 * made would be discarded before it ever reached the model. This resolves the *desired*
 * position against the world before the model commits to it instead.
 *
 * Reuses `collideBodies` (collision.ts) for the actual narrowphase test — a probe body
 * with one sphere collider stands in for the capsule, which is exact for the horizontal
 * slide this is used for (vertical is handled separately by the caller's own ground
 * height / jump / climb logic).
 */
import * as THREE from 'three';
import { createBody, updateBodyDerived, type RigidBody } from './rigidBody';
import { collider, sphere, aabbOverlaps, bodyCategory, CATEGORY_BUILDINGS, type Aabb, type SphereShape } from './types';
import { collideBodies } from './collision';
import type { PhysicsWorld } from './world';

export interface CharacterMoveResult {
  x: number;
  z: number;
  /** Highest top surface, in world Y, of a low obstacle blocking the way that is short
   * enough to step onto — null when nothing needs mantling this tick. */
  mantleTop: number | null;
  /** Highest top surface of an obstacle marked `userData.climbable` the character is
   * pressed against while attempting to climb — null otherwise. */
  climbTop: number | null;
}

/** De-penetration passes per call — enough to settle a corner (two overlapping
 * colliders resolved one after another can reintroduce a small overlap with the other)
 * without iterating for a case this simple. */
const RESOLVE_ITERATIONS = 3;
/** Query margin, in meters, added to the probe's own AABB before testing candidates —
 * covers the last iteration's worth of push-out without re-querying every pass. */
const QUERY_MARGIN = 0.6;

let probeBody: RigidBody | null = null;
let probeShape: SphereShape | null = null;

function getProbe(radius: number, offsetY: number): RigidBody {
  if (!probeBody || !probeShape) {
    probeShape = sphere(radius);
    probeBody = createBody({
      id: 'physics:character-probe',
      colliders: [collider(probeShape, new THREE.Vector3(0, offsetY, 0))],
      neverSleep: true,
    });
  } else {
    probeShape.radius = radius;
    probeBody.colliders[0].offset.y = offsetY;
  }
  return probeBody;
}

function expandAabb(aabb: Aabb, margin: number): Aabb {
  return {
    min: new THREE.Vector3(aabb.min.x - margin, aabb.min.y - margin, aabb.min.z - margin),
    max: new THREE.Vector3(aabb.max.x + margin, aabb.max.y + margin, aabb.max.z + margin),
  };
}

/**
 * Resolves a desired horizontal move against the world's static buildings/props,
 * sliding along whatever it touches instead of stopping dead, and reports whether the
 * blocking obstacle should instead be mantled or climbed (see gameplayConfig.CHARACTER).
 *
 * `feetY` is the character's current ground height — the probe's sphere collider is
 * placed `colliderOffsetY` above it, and only obstacles taller than `mantleHeight` above
 * it are treated as a wall rather than a step.
 */
export function resolveCharacterMovement(
  world: PhysicsWorld,
  feetY: number,
  desiredX: number,
  desiredZ: number,
  radius: number,
  colliderOffsetY: number,
  categoryMask: number,
  mantleHeight: number,
  attemptClimb: boolean,
): CharacterMoveResult {
  const body = getProbe(radius, colliderOffsetY);
  body.type = 'dynamic';
  body.position.set(desiredX, feetY, desiredZ);
  updateBodyDerived(body);

  let mantleTop: number | null = null;
  let climbTop: number | null = null;

  for (let pass = 0; pass < RESOLVE_ITERATIONS; pass += 1) {
    let pushed = false;
    const queryAabb = expandAabb(body.aabb, QUERY_MARGIN);
    for (const other of world.bodies()) {
      if (other === body || other.type !== 'static') continue;
      if ((bodyCategory(other.userData) & categoryMask) === 0) continue;
      if (!aabbOverlaps(queryAabb, other.aabb)) continue;

      const out: Parameters<typeof collideBodies>[2] = [];
      collideBodies(body, other, out);
      for (const manifold of out) {
        let penetration = 0;
        for (const point of manifold.points) penetration = Math.max(penetration, point.penetration);
        if (penetration <= 0) continue;

        const top = other.aabb.max.y;
        if (top - feetY <= mantleHeight) {
          mantleTop = mantleTop === null ? top : Math.max(mantleTop, top);
          continue;
        }
        if (attemptClimb && other.userData.climbable) {
          climbTop = climbTop === null ? top : Math.max(climbTop, top);
          continue;
        }

        // manifold.normal points from the probe (a) toward the obstacle (b) — push the
        // probe back along -normal by the horizontal share of the penetration. Vertical
        // collision (standing on something) is left to the caller's own ground height.
        const normal = manifold.normal;
        const horizontal = Math.hypot(normal.x, normal.z);
        if (horizontal < 1e-4) continue;
        const scale = penetration / horizontal;
        body.position.x -= normal.x * scale;
        body.position.z -= normal.z * scale;
        pushed = true;
      }
    }
    if (!pushed) break;
    updateBodyDerived(body);
  }

  return { x: body.position.x, z: body.position.z, mantleTop, climbTop };
}

/** Horizontal movement cannot resolve a ceiling. Sweep the head before accepting an
 * upward step, so jumping beneath a thin deck cannot put the feet onto its top surface. */
export function resolveCharacterCeiling(
  world: PhysicsWorld, x: number, z: number, previousY: number, desiredY: number,
  height: number, radius = 0.42,
): number {
  if (desiredY <= previousY) return desiredY;
  let allowed = desiredY;
  for (const [dx, dz] of [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]]) {
    const hit = world.raycast(
      new THREE.Vector3(x + dx, previousY + height, z + dz),
      new THREE.Vector3(0, 1, 0), desiredY - previousY, null, CATEGORY_BUILDINGS,
    );
    if (hit) allowed = Math.min(allowed, previousY + hit.distance - 0.001);
  }
  return allowed;
}
