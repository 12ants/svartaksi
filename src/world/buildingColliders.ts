/**
 * Footprint-to-collider descriptors for backlog item 4 (building collision frames).
 *
 * The default shape is one oriented box per building: the minimum-area rectangle of the
 * outer ring's convex hull (`minAreaOrientedRect`), extruded to the building's height,
 * sitting on the shared surface model (`terrainHeightAt`) so a collider's base agrees
 * with whatever the car/pill are actually standing on there.
 *
 * A single box is a bad fit for two shapes worth naming:
 *
 * - **Concave outlines** (L-shapes, courtyards) where the hull encloses area the
 *   building doesn't occupy — a player standing in the notch of an L, or in a
 *   courtyard, would be solved as inside solid wall. `footprintFitRatio` scores this
 *   (footprint area / oriented-box area); below `FIT_THRESHOLD` the box is rejected in
 *   favour of `perimeterWallSegments` — a thin box per ring edge, which follows the
 *   actual outline and lets the notch/courtyard stay open.
 * - **Multi-ring footprints** (a hole in the outer ring — an inner courtyard as its own
 *   ring) can't be a single convex box at all: always perimeter segments, walking every
 *   ring the building has, so both the outer wall and the wall around the inner hole are
 *   represented.
 *
 * This module is pure geometry — no THREE, no physics primitives — so the oriented-box
 * math and the fit heuristic are testable without pulling in the physics engine or a
 * WebGL context. `toRigidBodies` (bottom) is the one function that reaches into
 * `src/physics` to turn a descriptor into actual bodies for the streaming layer.
 */
import * as THREE from 'three';
import { minAreaOrientedRect, polygonArea } from './orientedRect';
import { ringCentroid } from './geo';
import type { LocalPoint, WorldBuilding } from './types';
import { terrainHeightAt, type TerrainClearance } from './terrain';
import { box, collider, type Collider } from '../physics/types';
import { createBody, type RigidBody } from '../physics/rigidBody';

/**
 * Below this fraction of the oriented box's area actually being footprint, the box is
 * considered a bad fit. 0.65 tolerates the corner-rounding a min-area rect always adds to
 * a plain rectangle (floating-point ring noise, near-rectangular real buildings) while
 * catching genuine L-shapes and courtyards, whose fit is typically 0.5 or worse.
 */
export const FIT_THRESHOLD = 0.65;

/** Half-thickness of a perimeter wall segment — thin enough not to visibly eat interior
 * floor space, thick enough that a fast car doesn't tunnel through it in one tick. */
export const WALL_HALF_THICKNESS = 0.15;

export interface ColliderBoxSpec {
  /** World-space centre. */
  position: LocalPoint;
  /** Elevation of the box's own centre (already includes half-height). */
  y: number;
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  halfWidth: number;
  halfHeight: number;
  halfDepth: number;
}

export interface BuildingColliderDescriptor {
  /** The building's own stable id — carried through so a streaming layer can dedupe
   * tile-seam copies and a debug view can trace a contact back to its source. */
  buildingId: string;
  /** 'box' for the common case; 'segments' for the concave/multi-ring fallback. */
  kind: 'box' | 'segments';
  boxes: ColliderBoxSpec[];
}

/** How well `rect` accounts for `ring`'s actual area: 1 is a perfect rectangle, lower
 * values mean the oriented box covers area the building doesn't occupy. */
export function footprintFitRatio(ring: readonly LocalPoint[]): number {
  const rect = minAreaOrientedRect(ring);
  const boxArea = (rect.halfWidth * 2) * (rect.halfDepth * 2);
  if (boxArea <= 0) return 0;
  return polygonArea(ring) / boxArea;
}

/** One thin box per ring edge, following the outline exactly rather than its hull. Used
 * for concave rings and for every ring of a multi-ring (courtyard) building. */
export function perimeterWallSegments(
  ring: readonly LocalPoint[],
  baseY: number,
  height: number,
): ColliderBoxSpec[] {
  const segments: ColliderBoxSpec[] = [];
  const n = ring.length;
  if (n < 2) return segments;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) continue;
    segments.push({
      position: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
      y: baseY + height / 2,
      yaw: Math.atan2(dz, dx),
      halfWidth: length / 2,
      halfHeight: height / 2,
      halfDepth: WALL_HALF_THICKNESS,
    });
  }
  return segments;
}

/**
 * Builds the collider descriptor for one building. Pure function of the building's rings
 * and height plus the terrain profile used for its base elevation — same building, same
 * terrain, same descriptor, which is what lets a streaming layer cache these by id and
 * never recompute the geometry on a visibility check (see `src/physics/buildingLayer.ts`).
 */
export function buildingColliderDescriptor(
  building: WorldBuilding,
  terrain: TerrainClearance[],
): BuildingColliderDescriptor | null {
  const outer = building.rings[0];
  if (!outer || outer.length < 3) return null;
  const height = Math.max(building.height, 0.5);

  // Base elevation from the shared surface model, sampled at the footprint's own
  // centroid — not (0,0) or a corner, which on sloped terrain would sit a whole edge of
  // the building either floating above or buried under the ground it's drawn on.
  const baseY = terrainHeightAt(ringCentroid(outer), terrain);

  const hasHoles = building.rings.length > 1;
  const fit = hasHoles ? 0 : footprintFitRatio(outer);

  if (!hasHoles && fit >= FIT_THRESHOLD) {
    const rect = minAreaOrientedRect(outer);
    return {
      buildingId: building.id,
      kind: 'box',
      boxes: [{
        position: rect.center,
        y: baseY + height / 2,
        yaw: rect.angle,
        halfWidth: rect.halfWidth,
        halfHeight: height / 2,
        halfDepth: rect.halfDepth,
      }],
    };
  }

  const boxes: ColliderBoxSpec[] = [];
  for (const ring of building.rings) boxes.push(...perimeterWallSegments(ring, baseY, height));
  if (boxes.length === 0) return null;
  return { buildingId: building.id, kind: 'segments', boxes };
}

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Turns a descriptor into the static rigid bodies the physics world actually solves
 * against. One body per box: a courtyard building's dozen wall segments each get their
 * own body rather than one compound body, which keeps the broadphase's per-cell bucket
 * counts sane (a compound body's AABB spans the whole courtyard, which would put it in
 * every cell the courtyard covers even though most of that area is empty air).
 */
export function buildingColliderBodies(
  descriptor: BuildingColliderDescriptor,
  category: number,
  mask: number,
): RigidBody[] {
  return descriptor.boxes.map((spec, index) => {
    // `spec.yaw` follows the atan2(dz, dx) convention used everywhere a building's
    // facades are drawn: it's the angle whose (cos, sin) is the box's local-x direction
    // in world xz. THREE's Y-axis rotation instead sends local x to (cos, -sin) for a
    // positive angle, so the sign has to be flipped here to keep the collider's box
    // pointed the same way as the facade it's meant to outline.
    const quaternion = new THREE.Quaternion().setFromAxisAngle(_up, -spec.yaw);
    const colliders: Collider[] = [collider(box(spec.halfWidth, spec.halfHeight, spec.halfDepth))];
    return createBody({
      id: `building:${descriptor.buildingId}:${index}`,
      type: 'static',
      position: new THREE.Vector3(spec.position.x, spec.y, spec.position.z),
      quaternion,
      colliders,
      userData: {
        layer: 'buildings',
        buildingId: descriptor.buildingId,
        category,
        mask,
        // Building edges are climbable by the pill (task 3's "climb-marked-surfaces").
        climbable: true,
      },
    });
  });
}
