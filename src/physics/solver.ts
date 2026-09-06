/**
 * Turns contacts into velocity changes: a sequential-impulse solver.
 *
 * Every contact point gets a non-penetration constraint and two friction constraints,
 * and the whole set is relaxed by iterating over it several times per tick. Impulses are
 * accumulated per point and clamped in aggregate rather than per iteration, which is what
 * lets a contact that was pushing hard early in the pass be pulled back later without the
 * body having already been launched.
 *
 * Penetration is bled off through a Baumgarte bias — a fraction of the overlap is added
 * to the target velocity — with a slop that leaves a fraction of a centimetre of overlap
 * alone. Correcting overlap all the way to zero makes resting contacts jitter, because
 * the correction becomes energy the next tick has to absorb.
 */
import * as THREE from 'three';
import type { Manifold } from './collision';
import { wakeBody, type RigidBody } from './rigidBody';

/** Fraction of the remaining overlap resolved per tick. Higher shoves objects apart
 * faster and more visibly; lower lets deep overlaps linger for several ticks. */
const BAUMGARTE = 0.2;
/** Overlap left uncorrected, in meters. */
const PENETRATION_SLOP = 0.008;
/** Approach speeds under this bounce not at all. Without it, a body resting under
 * gravity re-bounces on its own accumulated per-tick gravity every tick and buzzes. */
const RESTITUTION_THRESHOLD = 1;
/** Ceiling on the correction velocity, so a body that somehow starts deeply embedded
 * (a prop that streamed in inside the car) is pushed out briskly rather than fired. */
const MAX_CORRECTION_SPEED = 3;

/** Effective mass of a constraint along `direction` at arms `rA`/`rB`. */
function effectiveMass(
  a: RigidBody, b: RigidBody,
  rA: THREE.Vector3, rB: THREE.Vector3,
  direction: THREE.Vector3,
): number {
  let mass = a.invMass + b.invMass;
  if (a.invMass > 0) {
    _angular.copy(rA).cross(direction).applyMatrix3(a.invInertiaWorld).cross(rA);
    mass += _angular.dot(direction);
  }
  if (b.invMass > 0) {
    _angular.copy(rB).cross(direction).applyMatrix3(b.invInertiaWorld).cross(rB);
    mass += _angular.dot(direction);
  }
  return mass;
}

function applyPairImpulse(
  a: RigidBody, b: RigidBody,
  rA: THREE.Vector3, rB: THREE.Vector3,
  impulse: THREE.Vector3,
): void {
  if (a.invMass > 0) {
    a.linearVelocity.addScaledVector(impulse, -a.invMass);
    _angular.copy(rA).cross(impulse).applyMatrix3(a.invInertiaWorld);
    a.angularVelocity.sub(_angular);
  }
  if (b.invMass > 0) {
    b.linearVelocity.addScaledVector(impulse, b.invMass);
    _angular.copy(rB).cross(impulse).applyMatrix3(b.invInertiaWorld);
    b.angularVelocity.add(_angular);
  }
}

/** Relative velocity of b's material point minus a's, at the contact. */
function relativeVelocity(
  a: RigidBody, b: RigidBody,
  rA: THREE.Vector3, rB: THREE.Vector3,
  target: THREE.Vector3,
): THREE.Vector3 {
  target.copy(b.angularVelocity).cross(rB).add(b.linearVelocity);
  _velocity.copy(a.angularVelocity).cross(rA).add(a.linearVelocity);
  return target.sub(_velocity);
}

/** Two unit vectors spanning the plane perpendicular to `normal`. */
export function tangentBasis(
  normal: THREE.Vector3,
  tangent1: THREE.Vector3,
  tangent2: THREE.Vector3,
): void {
  // Cross with whichever world axis the normal is least aligned with, so the cross
  // product is never near-degenerate.
  if (Math.abs(normal.y) < 0.9) tangent1.set(0, 1, 0).cross(normal).normalize();
  else tangent1.set(1, 0, 0).cross(normal).normalize();
  tangent2.copy(normal).cross(tangent1).normalize();
}

/**
 * Relaxes every contact `iterations` times. Manifolds keep their accumulated impulses
 * for the whole call, so later iterations refine earlier ones rather than restating them.
 *
 * `previousImpulses` seeds each contact's normal impulse from last tick's converged value
 * for the same body pair, keyed by `${a.id}:${b.id}`. A resting contact's correct impulse
 * barely changes tick to tick, so seeding it lets the loop converge in a couple of
 * iterations instead of building it up from zero every time. The seed is clamped to
 * this tick's own accumulated-impulse floor (0, via the same `Math.max(0, ...)` the
 * iteration loop already uses below) rather than trusted outright, since a body that moved
 * can leave a contact with a legitimately smaller impulse than the one it warm-starts from;
 * the iteration loop then pulls any excess back out in its first pass. Returns the map of
 * this tick's converged impulses for the caller to pass back in next tick.
 */
export function solveContacts(
  manifolds: Manifold[],
  dt: number,
  iterations = 8,
  previousImpulses: Map<string, number> = new Map(),
): Map<string, number> {
  if (!manifolds.length || dt <= 0) return new Map();

  // Prepare: wake anything involved, and take each contact's bounce from the closing
  // speed it arrived with, before any of it (or the warm-start seed below) has been
  // applied.
  for (const manifold of manifolds) {
    if (manifold.a.type === 'dynamic' && manifold.a.sleeping) wakeBody(manifold.a);
    if (manifold.b.type === 'dynamic' && manifold.b.sleeping) wakeBody(manifold.b);
    for (const contact of manifold.points) {
      const rA = _armA.copy(contact.point).sub(manifold.a.position);
      const rB = _armB.copy(contact.point).sub(manifold.b.position);
      const approach = relativeVelocity(manifold.a, manifold.b, rA, rB, _relative).dot(manifold.normal);
      contact.restitutionBias = -approach > RESTITUTION_THRESHOLD
        ? -approach * manifold.restitution
        : 0;
    }
  }

  // Warm start: seed each contact's accumulated normal impulse from last tick's converged
  // value for the same body pair, and actually apply that impulse to velocities now — the
  // iteration loop below only ever applies the *delta* between iterations, so without this
  // pre-application the seed would sit in `normalImpulse` unused and the first iteration
  // would compute the same correction it would from cold. A contact that no longer exists
  // or is new gets `?? 0`, which is the correct cold-start value.
  for (const manifold of manifolds) {
    const seed = Math.max(0, previousImpulses.get(`${manifold.a.id}:${manifold.b.id}`) ?? 0);
    if (seed <= 0) continue;
    for (const contact of manifold.points) {
      contact.normalImpulse = seed;
      const rA = _armA.copy(contact.point).sub(manifold.a.position);
      const rB = _armB.copy(contact.point).sub(manifold.b.position);
      applyPairImpulse(manifold.a, manifold.b, rA, rB, _impulse.copy(manifold.normal).multiplyScalar(seed));
    }
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const manifold of manifolds) {
      const { a, b, normal } = manifold;
      if (a.invMass === 0 && b.invMass === 0) continue;
      for (const contact of manifold.points) {
        const rA = _armA.copy(contact.point).sub(a.position);
        const rB = _armB.copy(contact.point).sub(b.position);

        const relative = relativeVelocity(a, b, rA, rB, _relative);
        const approach = relative.dot(normal);
        const mass = effectiveMass(a, b, rA, rB, normal);
        if (mass <= 0) continue;

        const bias = Math.min(
          MAX_CORRECTION_SPEED,
          (BAUMGARTE / dt) * Math.max(0, contact.penetration - PENETRATION_SLOP),
        );
        let lambda = (-approach + bias + contact.restitutionBias) / mass;
        // Clamp the *accumulated* impulse at zero rather than this iteration's share,
        // so a contact can be relaxed back towards zero without ever pulling bodies
        // together (which is what a per-iteration clamp silently allows).
        const previousNormal = contact.normalImpulse;
        contact.normalImpulse = Math.max(0, previousNormal + lambda);
        lambda = contact.normalImpulse - previousNormal;
        applyPairImpulse(a, b, rA, rB, _impulse.copy(normal).multiplyScalar(lambda));

        if (contact.normalImpulse <= 0) continue;
        tangentBasis(normal, _tangent1, _tangent2);
        const limit = manifold.friction * contact.normalImpulse;
        const after = relativeVelocity(a, b, rA, rB, _relative);
        const tangents = [_tangent1, _tangent2] as const;
        const accumulated = [contact.tangentImpulse.x, contact.tangentImpulse.y];
        for (let axis = 0; axis < 2; axis += 1) {
          const tangent = tangents[axis];
          const tangentMass = effectiveMass(a, b, rA, rB, tangent);
          if (tangentMass <= 0) continue;
          const previous = accumulated[axis];
          // Coulomb: the friction impulse is clamped to a cone around the normal one.
          // Clamping each tangent independently makes the cone a square, which is a
          // standard and visually indistinguishable simplification.
          accumulated[axis] = THREE.MathUtils.clamp(
            previous + -after.dot(tangent) / tangentMass,
            -limit,
            limit,
          );
          applyPairImpulse(a, b, rA, rB, _impulse.copy(tangent).multiplyScalar(accumulated[axis] - previous));
        }
        contact.tangentImpulse.set(accumulated[0], accumulated[1]);
      }
    }
  }

  const converged = new Map<string, number>();
  for (const manifold of manifolds) {
    let maxImpulse = 0;
    for (const contact of manifold.points) maxImpulse = Math.max(maxImpulse, contact.normalImpulse);
    converged.set(`${manifold.a.id}:${manifold.b.id}`, maxImpulse);
  }
  return converged;
}


const _angular = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _armA = new THREE.Vector3();
const _armB = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _tangent1 = new THREE.Vector3();
const _tangent2 = new THREE.Vector3();
