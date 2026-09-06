/**
 * What each piece of street furniture is made of, and how hard it is to knock down.
 *
 * Everything here derives from two numbers per kind — a density and an anchor strength —
 * applied to the dimensions the world generator already chose for that particular
 * instance. Nothing is a hand-tuned per-object constant, so a nineteen-metre spruce is
 * heavier than a six-metre one because it is bigger, not because a table says so, and a
 * street tree planted by the same generator at half the height behaves like half the
 * tree.
 *
 * `anchorImpulse` is the momentum, in newton-seconds, needed to tear the thing out of the
 * ground. Momentum is the right currency: whether a bollard survives depends on the mass
 * and speed of whatever hits it, and their product is exactly an impulse. Expressed as a
 * multiple of the object's own weight-second so it scales with size the same way mass
 * does — a big tree is harder to fell than a sapling without that being stated twice.
 *
 * Rough calibration, for the numbers below: a 1500kg car at 10 m/s (36 km/h) carries
 * 15000 N·s. It should flatten a post box and a signal head, take a young street tree
 * with it, and come off worse against a mature forest pine.
 */
import * as THREE from 'three';
import { colliderVolume } from '../physics/rigidBody';
import { box, collider, type Collider } from '../physics/types';

export type PropKind =
  | 'tree'
  | 'street-light'
  | 'traffic-signal'
  | 'mailbox'
  | 'bus-stop'
  | 'fountain'
  | 'bench'
  | 'small-furniture'
  | 'mast';

export interface PropProfile {
  colliders: Collider[];
  mass: number;
  /** Newton-seconds of impact needed before it comes loose. */
  anchorImpulse: number;
  friction: number;
  restitution: number;
}

interface KindProfile {
  /** kg/m^3 of the collider volume. Hollow steel sections are given the density they
   * behave as, not the density of steel — a lamp post is a thin tube, not a solid bar. */
  density: number;
  /** Anchor strength as newton-seconds per kilogram of the object's own mass. A tree's
   * roots hold far better than four bolts through a base plate. */
  anchorPerKg: number;
  /**
   * Floor on that figure, in newton-seconds.
   *
   * Scaling anchor strength with mass alone gets small things badly wrong: a sapling
   * weighs sixty kilos and would come out of the ground at walking pace, which is not
   * how a sapling behaves. What holds a post down is mostly a property of how it is
   * *fixed* — a base plate, a socket, a root ball — and that barely shrinks with the
   * object above it. This is that fixed part.
   */
  minAnchor: number;
  friction: number;
  restitution: number;
}

const KINDS: Record<PropKind, KindProfile> = {
  // Green timber, roots in soil. The highest anchor here by a wide margin, and the one
  // thing on the list a car at town speed should regularly lose against: a mature pine
  // wants around 14 m/s (50 km/h) to fell, a street tree around half that.
  tree: { density: 700, anchorPerKg: 26, minAnchor: 9_000, friction: 0.85, restitution: 0.05 },
  // Hollow steel column on a bolted base plate, designed across most of Europe to shear
  // off rather than stop a car dead — around 20 km/h here.
  'street-light': { density: 620, anchorPerKg: 9, minAnchor: 7_000, friction: 0.5, restitution: 0.12 },
  'traffic-signal': { density: 560, anchorPerKg: 8, minAnchor: 6_000, friction: 0.5, restitution: 0.12 },
  // Sheet steel over a slim post, and lighter than it looks.
  mailbox: { density: 420, anchorPerKg: 7, minAnchor: 3_000, friction: 0.6, restitution: 0.15 },
  // A shelter is a big weak frame: no one leg is doing much, but there is a lot of it.
  'bus-stop': { density: 260, anchorPerKg: 5, minAnchor: 12_000, friction: 0.55, restitution: 0.1 },
  fountain: { density: 2200, anchorPerKg: 0, minAnchor: 0, friction: 0.85, restitution: 0.02 },
  // Not fixed down at all in most parks; a nudge moves it.
  bench: { density: 520, anchorPerKg: 2.5, minAnchor: 900, friction: 0.75, restitution: 0.05 },
  'small-furniture': { density: 380, anchorPerKg: 2, minAnchor: 1_500, friction: 0.7, restitution: 0.1 },
  // Tall, thin, and set in a concrete foundation.
  mast: { density: 700, anchorPerKg: 14, minAnchor: 12_000, friction: 0.5, restitution: 0.1 },
};

/**
 * Builds a profile for one instance from its kind and its own collision geometry.
 * `colliders` are in the prop's own frame with the origin at ground level, which is where
 * every generator in this world already places these things.
 */
export function propProfile(kind: PropKind, colliders: Collider[]): PropProfile {
  const profile = KINDS[kind];
  // Same volume the inertia tensor is built from, so a prop's mass and how it spins
  // about its own axis can never be derived from two different shapes.
  const volume = colliders.reduce((total, item) => total + colliderVolume(item), 0);
  const mass = Math.max(1, volume * profile.density);
  return {
    colliders,
    mass,
    anchorImpulse: Math.max(profile.minAnchor, mass * profile.anchorPerKg),
    friction: profile.friction,
    restitution: profile.restitution,
  };
}

/**
 * A tree: a trunk that reaches most of the way up, plus an upper section carrying the
 * mass of the canopy. Two parts rather than one, because a tree's mass being high up is
 * what makes a struck one rotate over the impact rather than slide.
 *
 * Only the height is needed: crown radius is a silhouette, and this is a mass model.
 */
export function treeColliders(height: number): Collider[] {
  // Trunk radius from height, not from crown radius: a tree's girth tracks how tall it
  // has grown far more closely than how wide its canopy has spread, and this is the
  // number the mass comes out of. About 0.14m at fifteen metres, which is a real spruce.
  const trunkRadius = Math.max(0.06, height * 0.009);
  const trunkHeight = height * 0.62;
  const crownHeight = height - trunkHeight;
  return [
    collider(box(trunkRadius, trunkHeight / 2, trunkRadius), new THREE.Vector3(0, trunkHeight / 2, 0)),
    collider(
      // The canopy above the trunk is branches and needles: it is what makes a struck
      // tree rotate over rather than slide, so it needs mass and a lever arm, but almost
      // none of the canopy's *width* is solid. Modelled as the upper trunk continuing,
      // not as the silhouette the renderer draws.
      box(trunkRadius * 0.8, crownHeight / 2, trunkRadius * 0.8),
      new THREE.Vector3(0, trunkHeight + crownHeight / 2, 0),
    ),
  ];
}

/** A lamp post: column only. The lantern is small enough to fold into the column's top. */
export function streetLightColliders(poleHeight = 4.6): Collider[] {
  return [collider(box(0.09, poleHeight / 2, 0.09), new THREE.Vector3(0, poleHeight / 2, 0))];
}

/** A signal head: pole plus the housing hung near the top of it. */
export function trafficSignalColliders(poleHeight = 3.6): Collider[] {
  return [
    collider(box(0.1, poleHeight / 2, 0.1), new THREE.Vector3(0, poleHeight / 2, 0)),
    collider(box(0.21, 0.58, 0.15), new THREE.Vector3(0, 3.15, 0)),
  ];
}

export function mailboxColliders(): Collider[] {
  return [
    collider(box(0.06, 0.5, 0.06), new THREE.Vector3(0, 0.5, 0)),
    collider(box(0.26, 0.32, 0.19), new THREE.Vector3(0, 1.16, 0)),
  ];
}

/** A shelter: four legs' worth of frame reduced to two side panels, plus the roof. */
export function busStopColliders(): Collider[] {
  return [
    collider(box(0.08, 1.15, 0.7), new THREE.Vector3(-1.15, 1.15, 0)),
    collider(box(0.08, 1.15, 0.7), new THREE.Vector3(1.15, 1.15, 0)),
    collider(box(1.3, 0.06, 0.8), new THREE.Vector3(0, 2.36, 0)),
  ];
}

export function benchColliders(): Collider[] {
  return [
    collider(box(0.9, 0.355, 0.26), new THREE.Vector3(0, 0.355, 0)),
    collider(box(0.9, 0.2, 0.05), new THREE.Vector3(0, 0.88, -0.22)),
  ];
}

/** Anything short and stubby the world scatters: bins, bollards, small artworks. */
export function smallFurnitureColliders(radius: number, height: number): Collider[] {
  return [collider(box(radius, height / 2, radius), new THREE.Vector3(0, height / 2, 0))];
}

export function mastColliders(height = 8): Collider[] {
  return [collider(box(0.08, height / 2, 0.08), new THREE.Vector3(0, height / 2, 0))];
}
