/**
 * Narrowphase: given two bodies whose bounds already overlap, work out whether their
 * shapes actually touch, along which direction, and at which points.
 *
 * Box-vs-box uses the separating axis theorem over the 15 candidate axes (three face
 * normals each, nine edge-edge cross products), then builds a contact patch by clipping
 * the incident face against the side planes of the reference face. A patch rather than a
 * single point is what lets a fallen lamp post lie still instead of rocking: one contact
 * can only ever resist rotation through the solver's iteration, four along the length of
 * the post resist it directly.
 *
 * The edge-edge case is given a single contact at the midpoint of the two support
 * points. That is a simplification of the exact closest-points-between-segments answer,
 * and it is the right trade here: edge-edge contacts arise on a corner strike, which is
 * transient by nature — a car clipping a post spends one or two ticks in that
 * configuration before it becomes a face contact or the post is gone.
 */
import * as THREE from 'three';
import type { RigidBody } from './rigidBody';
import { colliderCentre } from './types';
import type { BoxShape, Collider, SphereShape } from './types';

export interface ContactPoint {
  /** World-space position of the contact. */
  point: THREE.Vector3;
  /** Overlap depth along the manifold normal; positive means interpenetrating. */
  penetration: number;
  /** Accumulated impulses, owned by the solver across its iterations. */
  normalImpulse: number;
  tangentImpulse: THREE.Vector2;
  /**
   * Separation speed this contact owes to restitution, worked out once from the closing
   * speed the contact was *found* at. It has to be computed before any impulse is applied
   * and then held: after the first relaxation pass the bodies are already separating, so a
   * per-iteration reading of the approach speed says there is nothing to bounce off and
   * the later passes take the bounce straight back out again.
   */
  restitutionBias: number;
}

export interface Manifold {
  a: RigidBody;
  b: RigidBody;
  /** Unit vector pointing from `a` towards `b`; resolving pushes `b` along it. */
  normal: THREE.Vector3;
  points: ContactPoint[];
  friction: number;
  restitution: number;
}

/** Shapes closer than this are treated as touching, which keeps resting stacks stable. */
const CONTACT_SLOP = 0.005;
/** Guards the SAT axis tests against near-parallel boxes, where a cross product of two
 * almost-identical axes is numerical noise rather than a real separating direction. */
const PARALLEL_EPSILON = 1e-6;

interface BoxFrame {
  centre: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  extents: THREE.Vector3;
}

/** Places a box collider in world space: its centre, its three unit axes, its extents. */
export function boxFrame(
  item: Collider,
  shape: BoxShape,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): BoxFrame {
  const orientation = new THREE.Quaternion().copy(quaternion).multiply(item.rotation);
  const basis = new THREE.Matrix4().makeRotationFromQuaternion(orientation);
  const e = basis.elements;
  return {
    centre: colliderCentre(item, position, quaternion, new THREE.Vector3()),
    axes: [
      new THREE.Vector3(e[0], e[1], e[2]),
      new THREE.Vector3(e[4], e[5], e[6]),
      new THREE.Vector3(e[8], e[9], e[10]),
    ],
    extents: shape.halfExtents,
  };
}

function sphereCentre(item: Collider, position: THREE.Vector3, quaternion: THREE.Quaternion): THREE.Vector3 {
  return colliderCentre(item, position, quaternion, new THREE.Vector3());
}

/** Extent of a box along an arbitrary world direction. */
function projectedExtent(frame: BoxFrame, axis: THREE.Vector3): number {
  return Math.abs(frame.axes[0].dot(axis)) * frame.extents.x
    + Math.abs(frame.axes[1].dot(axis)) * frame.extents.y
    + Math.abs(frame.axes[2].dot(axis)) * frame.extents.z;
}

/** The corner of a box furthest along `axis`. */
function boxSupport(frame: BoxFrame, axis: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  target.copy(frame.centre);
  const e = [frame.extents.x, frame.extents.y, frame.extents.z];
  for (let i = 0; i < 3; i += 1) {
    target.addScaledVector(frame.axes[i], frame.axes[i].dot(axis) >= 0 ? e[i] : -e[i]);
  }
  return target;
}

interface Separation {
  /** Smallest overlap found, in meters. Negative means the boxes are apart. */
  depth: number;
  /** World-space axis of that overlap, oriented from A towards B. */
  axis: THREE.Vector3;
  /** 0..2 face of A, 3..5 face of B, 6+ edge-edge. */
  index: number;
}

/**
 * Minimum-penetration separating axis between two boxes, or null if any axis separates
 * them outright. `index` records which of the 15 candidates won, because the manifold is
 * built differently for a face axis than for an edge-edge one.
 */
export function separateBoxes(a: BoxFrame, b: BoxFrame): Separation | null {
  const delta = _delta.copy(b.centre).sub(a.centre);
  let best: Separation | null = null;

  const test = (axis: THREE.Vector3, index: number): boolean => {
    const lengthSq = axis.lengthSq();
    if (lengthSq < PARALLEL_EPSILON) return true;
    const unit = _unit.copy(axis).multiplyScalar(1 / Math.sqrt(lengthSq));
    const overlap = projectedExtent(a, unit) + projectedExtent(b, unit) - Math.abs(delta.dot(unit));
    if (overlap < 0) return false;
    if (!best || overlap < best.depth) {
      const oriented = unit.clone();
      if (oriented.dot(delta) < 0) oriented.negate();
      best = { depth: overlap, axis: oriented, index };
    }
    return true;
  };

  for (let i = 0; i < 3; i += 1) if (!test(a.axes[i], i)) return null;
  for (let i = 0; i < 3; i += 1) if (!test(b.axes[i], 3 + i)) return null;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (!test(_cross.crossVectors(a.axes[i], b.axes[j]), 6 + i * 3 + j)) return null;
    }
  }
  return best;
}

/** Index of the box axis most aligned with `normal`, and which way along it. */
function dominantAxis(frame: BoxFrame, normal: THREE.Vector3): { axis: number; sign: number } {
  let axis = 0;
  let best = -Infinity;
  let sign = 1;
  for (let i = 0; i < 3; i += 1) {
    const dot = frame.axes[i].dot(normal);
    if (Math.abs(dot) > best) {
      best = Math.abs(dot);
      axis = i;
      sign = dot >= 0 ? 1 : -1;
    }
  }
  return { axis, sign };
}

/** The four corners of the face of `frame` whose outward normal is `axis`*`sign`. */
function faceVertices(frame: BoxFrame, axis: number, sign: number): THREE.Vector3[] {
  const e = [frame.extents.x, frame.extents.y, frame.extents.z];
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const centre = frame.centre.clone().addScaledVector(frame.axes[axis], sign * e[axis]);
  const vertices: THREE.Vector3[] = [];
  for (const [su, sv] of FACE_CORNERS) {
    vertices.push(centre.clone()
      .addScaledVector(frame.axes[u], su * e[u])
      .addScaledVector(frame.axes[v], sv * e[v]));
  }
  return vertices;
}

/** Sutherland-Hodgman: keeps the part of `polygon` on the inner side of one plane. */
function clipAgainstPlane(
  polygon: THREE.Vector3[],
  planeNormal: THREE.Vector3,
  planeOffset: number,
): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const distanceCurrent = planeNormal.dot(current) - planeOffset;
    const distanceNext = planeNormal.dot(next) - planeOffset;
    if (distanceCurrent <= 0) result.push(current.clone());
    if ((distanceCurrent > 0) !== (distanceNext > 0)) {
      const t = distanceCurrent / (distanceCurrent - distanceNext);
      result.push(current.clone().lerp(next, t));
    }
  }
  return result;
}

/** One place that knows every field a fresh ContactPoint needs — the ground path in
 * world.ts builds them too. */
export function makeContact(point: THREE.Vector3, penetration: number): ContactPoint {
  return {
    point,
    penetration,
    normalImpulse: 0,
    tangentImpulse: new THREE.Vector2(),
    restitutionBias: 0,
  };
}

/** Builds the contact patch for a face-axis separation by clipping incident to reference. */
function clipFaceContacts(
  reference: BoxFrame,
  incident: BoxFrame,
  normal: THREE.Vector3,
): ContactPoint[] {
  const ref = dominantAxis(reference, normal);
  const inc = dominantAxis(incident, _negated.copy(normal).negate());
  let polygon = faceVertices(incident, inc.axis, inc.sign);

  const refExtents = [reference.extents.x, reference.extents.y, reference.extents.z];
  // Clip against the four side planes of the reference face — the planes through its
  // edges, perpendicular to the face — leaving only the part of the incident face that
  // actually sits over it.
  for (const side of [(ref.axis + 1) % 3, (ref.axis + 2) % 3]) {
    const axis = reference.axes[side];
    const centreOffset = axis.dot(reference.centre);
    polygon = clipAgainstPlane(polygon, axis, centreOffset + refExtents[side]);
    polygon = clipAgainstPlane(polygon, _negated.copy(axis).negate(), -(centreOffset - refExtents[side]));
    if (!polygon.length) return [];
  }

  // Keep only the clipped points that are actually behind the reference face plane, and
  // record how far behind — that is each point's own penetration depth.
  const faceNormal = _faceNormal.copy(reference.axes[ref.axis]).multiplyScalar(ref.sign);
  const facePlane = faceNormal.dot(reference.centre) + refExtents[ref.axis];
  const contacts: ContactPoint[] = [];
  for (const point of polygon) {
    const depth = facePlane - faceNormal.dot(point);
    if (depth < -CONTACT_SLOP) continue;
    contacts.push(makeContact(point, Math.max(0, depth)));
  }
  return contacts;
}

function collideBoxBox(
  a: RigidBody, itemA: Collider, shapeA: BoxShape,
  b: RigidBody, itemB: Collider, shapeB: BoxShape,
): Manifold | null {
  const frameA = boxFrame(itemA, shapeA, a.position, a.quaternion);
  const frameB = boxFrame(itemB, shapeB, b.position, b.quaternion);
  const separation = separateBoxes(frameA, frameB);
  if (!separation) return null;

  let points: ContactPoint[];
  if (separation.index < 6) {
    const referenceIsA = separation.index < 3;
    points = referenceIsA
      ? clipFaceContacts(frameA, frameB, separation.axis)
      // Reference face on B, so the normal has to be looked at from B's side. A fresh
      // vector, not a scratch one: clipFaceContacts uses the module scratch itself.
      : clipFaceContacts(frameB, frameA, separation.axis.clone().negate());
  } else {
    // Edge-edge: one contact, midway between the two boxes' support points along the
    // separating axis. See the file comment for why a single point is enough here.
    const supportA = boxSupport(frameA, separation.axis, new THREE.Vector3());
    const supportB = boxSupport(frameB, _negated.copy(separation.axis).negate(), new THREE.Vector3());
    points = [makeContact(supportA.lerp(supportB, 0.5), separation.depth)];
  }
  if (!points.length) return null;
  return {
    a, b,
    normal: separation.axis,
    points,
    friction: Math.sqrt(a.friction * b.friction),
    restitution: Math.max(a.restitution, b.restitution),
  };
}

function collideSphereBox(
  sphereBody: RigidBody, sphereItem: Collider, sphereShape: SphereShape,
  boxBody: RigidBody, boxItem: Collider, boxShape: BoxShape,
  /** True when the sphere is body `a` of the resulting manifold. */
  sphereFirst: boolean,
): Manifold | null {
  const frame = boxFrame(boxItem, boxShape, boxBody.position, boxBody.quaternion);
  const centre = sphereCentre(sphereItem, sphereBody.position, sphereBody.quaternion);
  const local = _local.copy(centre).sub(frame.centre);
  const extents = [frame.extents.x, frame.extents.y, frame.extents.z];

  // Closest point on the box, found by clamping the sphere centre's coordinate along
  // each box axis to that axis's extent.
  const closest = _closest.copy(frame.centre);
  let inside = true;
  for (let i = 0; i < 3; i += 1) {
    const raw = local.dot(frame.axes[i]);
    const clamped = Math.max(-extents[i], Math.min(extents[i], raw));
    if (clamped !== raw) inside = false;
    closest.addScaledVector(frame.axes[i], clamped);
  }

  const toSphere = _toSphere.copy(centre).sub(closest);
  let distance = toSphere.length();
  let normal: THREE.Vector3;
  if (inside) {
    // Centre is within the box: push out along whichever face it is nearest to, since
    // the closest-point vector is degenerate there.
    let bestAxis = 0;
    let bestSlack = Infinity;
    let bestSign = 1;
    for (let i = 0; i < 3; i += 1) {
      const raw = local.dot(frame.axes[i]);
      const slack = extents[i] - Math.abs(raw);
      if (slack < bestSlack) {
        bestSlack = slack;
        bestAxis = i;
        bestSign = raw >= 0 ? 1 : -1;
      }
    }
    normal = frame.axes[bestAxis].clone().multiplyScalar(bestSign);
    distance = -bestSlack;
  } else {
    if (distance >= sphereShape.radius) return null;
    normal = distance > 1e-6 ? toSphere.clone().multiplyScalar(1 / distance) : new THREE.Vector3(0, 1, 0);
  }
  const penetration = sphereShape.radius - distance;
  // The manifold normal always runs from `a` to `b`; here it points box -> sphere, so it
  // is used as-is when the box is `a` and negated when the sphere is.
  const contact = makeContact(
    closest.clone().addScaledVector(normal, Math.max(0, penetration) * 0.5),
    penetration,
  );
  const friction = Math.sqrt(sphereBody.friction * boxBody.friction);
  const restitution = Math.max(sphereBody.restitution, boxBody.restitution);
  return sphereFirst
    ? { a: sphereBody, b: boxBody, normal: normal.negate(), points: [contact], friction, restitution }
    : { a: boxBody, b: sphereBody, normal, points: [contact], friction, restitution };
}

function collideSphereSphere(
  a: RigidBody, itemA: Collider, shapeA: SphereShape,
  b: RigidBody, itemB: Collider, shapeB: SphereShape,
): Manifold | null {
  const centreA = sphereCentre(itemA, a.position, a.quaternion);
  const centreB = sphereCentre(itemB, b.position, b.quaternion);
  const delta = _delta.copy(centreB).sub(centreA);
  const distance = delta.length();
  const radii = shapeA.radius + shapeB.radius;
  if (distance >= radii) return null;
  const normal = distance > 1e-6
    ? delta.clone().multiplyScalar(1 / distance)
    : new THREE.Vector3(0, 1, 0);
  return {
    a, b,
    normal,
    points: [makeContact(centreA.clone().addScaledVector(normal, shapeA.radius), radii - distance)],
    friction: Math.sqrt(a.friction * b.friction),
    restitution: Math.max(a.restitution, b.restitution),
  };
}

/**
 * Every manifold between two bodies, one per touching pair of their colliders. Compound
 * bodies really do need one each: a signal head's pole and its housing are struck at
 * different heights by different things, and merging them into one contact would lose
 * exactly the lever arm that decides which way it falls.
 */
export function collideBodies(a: RigidBody, b: RigidBody, out: Manifold[]): void {
  for (const itemA of a.colliders) {
    for (const itemB of b.colliders) {
      let manifold: Manifold | null = null;
      if (itemA.shape.kind === 'box' && itemB.shape.kind === 'box') {
        manifold = collideBoxBox(a, itemA, itemA.shape, b, itemB, itemB.shape);
      } else if (itemA.shape.kind === 'sphere' && itemB.shape.kind === 'box') {
        manifold = collideSphereBox(a, itemA, itemA.shape, b, itemB, itemB.shape, true);
      } else if (itemA.shape.kind === 'box' && itemB.shape.kind === 'sphere') {
        manifold = collideSphereBox(b, itemB, itemB.shape, a, itemA, itemA.shape, false);
      } else if (itemA.shape.kind === 'sphere' && itemB.shape.kind === 'sphere') {
        manifold = collideSphereSphere(a, itemA, itemA.shape, b, itemB, itemB.shape);
      }
      if (manifold) out.push(manifold);
    }
  }
}

/** Every corner of a box collider in world space — used by the ground contact pass. */
export function boxCorners(
  item: Collider,
  shape: BoxShape,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): THREE.Vector3[] {
  const frame = boxFrame(item, shape, position, quaternion);
  const corners: THREE.Vector3[] = [];
  for (const sx of SIGNS) {
    for (const sy of SIGNS) {
      for (const sz of SIGNS) {
        corners.push(frame.centre.clone()
          .addScaledVector(frame.axes[0], sx * frame.extents.x)
          .addScaledVector(frame.axes[1], sy * frame.extents.y)
          .addScaledVector(frame.axes[2], sz * frame.extents.z));
      }
    }
  }
  return corners;
}


const SIGNS = [-1, 1] as const;
const FACE_CORNERS = [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const;

const _delta = new THREE.Vector3();
const _unit = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _negated = new THREE.Vector3();
const _faceNormal = new THREE.Vector3();
const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _toSphere = new THREE.Vector3();
