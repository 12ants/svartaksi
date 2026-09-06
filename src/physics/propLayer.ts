/**
 * Gives the world's street furniture a physical presence, and puts what happens to it
 * back on screen.
 *
 * Two things this layer is careful about:
 *
 * **Only what is near matters.** A streamed snapshot can hold nine thousand trees. All of
 * them get a collision frame in principle, but a body is only created for the ones inside
 * a radius of wherever the player is, and the set is recomputed only once the player has
 * actually moved a meaningful distance. Simulating a forest six hundred metres away that
 * nothing can reach is pure cost.
 *
 * **A prop that has been knocked over must stay knocked over.** Its pose is remembered by
 * id, so driving away and back — which rebuilds bodies, and can rebuild the rendered
 * world entirely — finds the post still lying where it was left rather than standing
 * innocently back up.
 */
import * as THREE from 'three';
import { createBody, type RigidBody } from './rigidBody';
import { propProfile } from '../world/propProfiles';
import { CATEGORY_ALL, CATEGORY_PROPS } from './types';
import type { PhysicsWorld } from './world';
import { applyPropTransform, type WorldProp } from '../world/propRegistry';

export interface PropLayerOptions {
  /** Radius around the focus point within which props are given bodies. */
  activeRadius?: number;
  /** How far the focus must move before the active set is recomputed. */
  refreshDistance?: number;
  /** Ceiling on simultaneous prop bodies, nearest first. */
  maxBodies?: number;
}

export interface PropLayer {
  /** Adopts a new set of props — call whenever the rendered world is rebuilt. */
  setProps(props: WorldProp[]): void;
  /** Rebuilds the active body set if `focus` has moved far enough. Cheap otherwise. */
  update(focus: THREE.Vector3): void;
  /** Pushes every disturbed prop's pose back into its instanced meshes. Once per frame. */
  sync(): void;
  /** How many props have been knocked over this session. */
  dislodgedCount(): number;
  dispose(): void;
}

const PROP_LAYER = 'props';

/** Poses are remembered by prop id, which the world generators derive from stable OSM
 * ids and placement indices — so the same post box is the same prop across rebuilds. */
interface DislodgedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Still settling: keeps being written back until the body sleeps. */
  body: RigidBody | null;
}

export function createPropLayer(world: PhysicsWorld, options: PropLayerOptions = {}): PropLayer {
  const activeRadius = options.activeRadius ?? 220;
  const refreshDistance = options.refreshDistance ?? 45;
  const maxBodies = options.maxBodies ?? 900;

  let props: WorldProp[] = [];
  const active = new Map<string, { prop: WorldProp; body: RigidBody }>();
  const dislodged = new Map<string, DislodgedPose>();
  const lastFocus = new THREE.Vector3(Infinity, 0, Infinity);
  let disposed = false;

  world.onDislodge((body) => {
    const id = body.userData.propId;
    if (typeof id !== 'string') return;
    dislodged.set(id, {
      position: body.position.clone(),
      quaternion: body.quaternion.clone(),
      body,
    });
  });

  const clearBodies = () => {
    // One reverse pass over the world's body list rather than an indexOf-and-splice per
    // body: with 900 props active, the per-body form is a quarter of a million
    // comparisons plus 900 array shifts, all landing in the single frame that a refresh
    // happens to fall on.
    world.removeLayer(PROP_LAYER);
    active.clear();
  };

  const bodyFor = (prop: WorldProp): RigidBody => {
    const profile = propProfile(prop.kind, prop.colliders);
    const remembered = dislodged.get(prop.id);
    const body = createBody({
      id: `prop:${prop.id}`,
      // A prop already knocked over comes back as what it became, not as what it was.
      type: remembered ? 'dynamic' : 'static',
      mass: profile.mass,
      colliders: prop.colliders,
      position: remembered ? remembered.position : prop.position,
      quaternion: remembered
        ? remembered.quaternion
        : new THREE.Quaternion().setFromAxisAngle(_up, prop.yaw),
      friction: profile.friction,
      restitution: profile.restitution,
      userData: {
        layer: PROP_LAYER,
        propId: prop.id,
        mass: profile.mass,
        // Masonry stays static; omitting the anchor disables breakaway promotion.
        anchorImpulse: prop.kind === 'fountain' ? undefined : profile.anchorImpulse,
        category: CATEGORY_PROPS,
        mask: CATEGORY_ALL,
        // Marks this prop as scalable by the pill's climb ability (task 3) — trees only;
        // street furniture is either too short to need climbing (mantled instead) or not
        // something a person should be able to shin up.
        climbable: prop.kind === 'tree',
      },
    });
    if (remembered) {
      remembered.body = body;
      // Restored already at rest; it must not re-enact its fall every time it is rebuilt.
      body.sleeping = true;
    }
    return body;
  };

  const rebuildActive = (focus: THREE.Vector3) => {
    clearBodies();
    const radiusSq = activeRadius * activeRadius;
    const candidates: Array<{ prop: WorldProp; distanceSq: number }> = [];
    for (const prop of props) {
      const dx = prop.position.x - focus.x;
      const dz = prop.position.z - focus.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > radiusSq) continue;
      candidates.push({ prop, distanceSq });
    }
    // Nearest first, so the cap costs the props furthest from the player rather than an
    // arbitrary slice of whatever order the generators happened to emit.
    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    for (const candidate of candidates.slice(0, maxBodies)) {
      const body = bodyFor(candidate.prop);
      world.addBody(body);
      active.set(candidate.prop.id, { prop: candidate.prop, body });
      // A rebuilt world draws this prop standing up again until it is told otherwise, so
      // a remembered pose is written straight away rather than on the next sync.
      if (dislodged.has(candidate.prop.id)) {
        applyPropTransform(candidate.prop, body.position, body.quaternion);
      }
    }
    lastFocus.copy(focus);
  };

  return {
    setProps(next) {
      props = next;
      // Force the next update to rebuild: the bodies currently held refer to meshes that
      // the world has just replaced, and writing to those would draw nothing.
      lastFocus.set(Infinity, 0, Infinity);
      clearBodies();
    },
    update(focus) {
      if (disposed) return;
      const dx = focus.x - lastFocus.x;
      const dz = focus.z - lastFocus.z;
      if (dx * dx + dz * dz < refreshDistance * refreshDistance) return;
      rebuildActive(focus);
    },
    sync() {
      for (const [id, pose] of dislodged) {
        const body = pose.body;
        if (!body) continue;
        pose.position.copy(body.position);
        pose.quaternion.copy(body.quaternion);
        const entry = active.get(id);
        if (entry) applyPropTransform(entry.prop, body.position, body.quaternion);
        // Once it has settled, keep the pose but stop writing it every frame. It is
        // already drawn where it lies, and it will be restored from `pose` if the world
        // is rebuilt around it.
        if (body.sleeping) pose.body = null;
      }
    },
    dislodgedCount: () => dislodged.size,
    dispose() {
      disposed = true;
      clearBodies();
      world.removeLayer(PROP_LAYER);
      props = [];
    },
  };
}

const _up = new THREE.Vector3(0, 1, 0);
