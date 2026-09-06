/**
 * Streams building colliders into the physics world within a radius of the player,
 * reusing descriptors across visibility checks the way `propLayer` reuses props
 * (backlog item 4).
 *
 * Rendering visibility must not control collision: a building the culler has stopped
 * drawing because it is behind the camera can still be the wall a reversing car needs to
 * stop against, so this layer is fed the *full* building set from the current world
 * snapshot, not whatever `threeWorld` currently has instanced.
 *
 * Two things this layer is careful about, mirroring why the prop layer is built the way
 * it is:
 *
 * **Hysteresis.** A building right at the activation radius, with the player idling near
 * the boundary, would otherwise gain and drop its collider every time distance crossed
 * the threshold — a static body added and removed from the broadphase's static index each
 * such frame, which is the one operation in this world that is not cheap (it is a full
 * `broadphase.setStatic` reindex, not a per-body op). A building only *enters* inside
 * `activeRadius` and only *leaves* past the larger `releaseRadius`; the gap between them
 * is the hysteresis band.
 *
 * **Descriptor reuse.** `buildingColliderDescriptor` is pure — same building, same
 * terrain, same answer — so it is computed once per building id and kept for as long as
 * the world snapshot it came from is current, rather than recomputed on every refresh a
 * building cycles active.
 */
import * as THREE from 'three';
import {
  buildingColliderBodies,
  buildingColliderDescriptor,
  type BuildingColliderDescriptor,
} from '../world/buildingColliders';
import { ringCentroid } from '../world/geo';
import type { RigidBody } from './rigidBody';
import type { PhysicsWorld } from './world';
import type { TerrainClearance } from '../world/terrain';
import type { WorldBuilding } from '../world/types';
import { CATEGORY_ALL, CATEGORY_BUILDINGS } from './types';

export interface BuildingLayerOptions {
  /** Radius around the focus point within which a building gains a collider. */
  activeRadius?: number;
  /** Added to `activeRadius` to get the radius past which a building loses its collider —
   * the hysteresis band. Must stay positive or every crossing would flap. */
  releaseMargin?: number;
  /** How far the focus must move before the active set is even reconsidered. */
  refreshDistance?: number;
  category?: number;
  mask?: number;
}

export interface BuildingLayer {
  /** Adopts a new building set and terrain profile — call whenever the world snapshot
   * (a fresh OSM fetch, a streamed tile) changes. Drops every active body and clears the
   * descriptor cache, since both were computed against the snapshot being replaced. */
  setWorld(buildings: readonly WorldBuilding[], terrain: TerrainClearance[]): void;
  /** Reconciles the active body set against `focus` if it has moved far enough since the
   * last refresh. Cheap otherwise — a single squared-distance check. */
  update(focus: THREE.Vector3): void;
  /** How many buildings currently have a live collider. */
  activeBuildingCount(): number;
  /** How many static bodies are currently in the physics world for this layer. */
  activeBodyCount(): number;
  dispose(): void;
}

const BUILDING_LAYER = 'buildings';

export function createBuildingLayer(world: PhysicsWorld, options: BuildingLayerOptions = {}): BuildingLayer {
  const activeRadius = options.activeRadius ?? 140;
  const releaseRadius = activeRadius + Math.max(1, options.releaseMargin ?? 40);
  const refreshDistance = options.refreshDistance ?? 25;
  const category = options.category ?? CATEGORY_BUILDINGS;
  const mask = options.mask ?? CATEGORY_ALL;

  let buildings: readonly WorldBuilding[] = [];
  let terrain: TerrainClearance[] = [];
  // Descriptor cache: keyed by building id, kept across refreshes so a building cycling
  // in and out of range never pays for `buildingColliderDescriptor` twice. `null` is a
  // cached negative — a footprint too degenerate to collide with — cached the same way so
  // it, too, is not recomputed on every pass.
  const descriptors = new Map<string, BuildingColliderDescriptor | null>();
  const active = new Map<string, RigidBody[]>();
  const lastFocus = new THREE.Vector3(Infinity, 0, Infinity);
  let bodyCount = 0;
  let disposed = false;

  const descriptorFor = (building: WorldBuilding): BuildingColliderDescriptor | null => {
    const cached = descriptors.get(building.id);
    if (cached !== undefined) return cached;
    const computed = buildingColliderDescriptor(building, terrain);
    descriptors.set(building.id, computed);
    return computed;
  };

  const activate = (building: WorldBuilding): void => {
    if (active.has(building.id)) return;
    const descriptor = descriptorFor(building);
    if (!descriptor) return;
    const bodies = buildingColliderBodies(descriptor, category, mask);
    for (const body of bodies) world.addBody(body);
    active.set(building.id, bodies);
    bodyCount += bodies.length;
  };

  const deactivate = (id: string): void => {
    const bodies = active.get(id);
    if (!bodies) return;
    for (const body of bodies) world.removeBody(body);
    active.delete(id);
    bodyCount -= bodies.length;
  };

  const clearActive = (): void => {
    for (const id of active.keys()) deactivate(id);
  };

  const refresh = (focus: THREE.Vector3): void => {
    const activeSq = activeRadius * activeRadius;
    const releaseSq = releaseRadius * releaseRadius;
    // Tile-seam copies of the same building share an id; only the first one seen in this
    // pass is considered, so a duplicate can never gain a second set of bodies.
    const seen = new Set<string>();
    for (const building of buildings) {
      if (seen.has(building.id)) continue;
      seen.add(building.id);
      const outer = building.rings[0];
      if (!outer || outer.length < 3) continue;
      const centroid = ringCentroid(outer);
      const dx = centroid.x - focus.x;
      const dz = centroid.z - focus.z;
      const distSq = dx * dx + dz * dz;
      const isActive = active.has(building.id);
      if (!isActive && distSq <= activeSq) activate(building);
      else if (isActive && distSq > releaseSq) deactivate(building.id);
    }
    // Anything active that is no longer in the current building set at all (a rebuilt
    // world dropped it) is stale and must not linger as an unreachable body.
    for (const id of [...active.keys()]) {
      if (!seen.has(id)) deactivate(id);
    }
  };

  return {
    setWorld(newBuildings, newTerrain) {
      if (disposed) return;
      buildings = newBuildings;
      terrain = newTerrain;
      descriptors.clear();
      clearActive();
      // Force the next update() to refresh regardless of how little the focus has moved —
      // the world under it just changed, so the previous focus's proximity answer no
      // longer means anything.
      lastFocus.set(Infinity, 0, Infinity);
    },
    update(focus) {
      if (disposed) return;
      if (lastFocus.distanceToSquared(focus) < refreshDistance * refreshDistance) return;
      lastFocus.copy(focus);
      refresh(focus);
    },
    activeBuildingCount: () => active.size,
    activeBodyCount: () => bodyCount,
    dispose() {
      if (disposed) return;
      disposed = true;
      world.removeLayer(BUILDING_LAYER);
      active.clear();
      descriptors.clear();
      bodyCount = 0;
    },
  };
}
