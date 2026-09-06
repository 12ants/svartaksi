import * as THREE from 'three';
import type { BridgeCollider } from '../world/bridgeColliders';
import { createBody, type RigidBody } from './rigidBody';
import { box, collider, CATEGORY_ALL, CATEGORY_BUILDINGS } from './types';
import type { PhysicsWorld } from './world';

export interface BridgeLayer {
  setColliders(colliders: readonly BridgeCollider[]): void;
  update(focus: THREE.Vector3): void;
  dispose(): void;
}

/** Collision range is independent of camera visibility. Descriptors arrive with the
 * committed road meshes, so a partially built replacement never changes the ground. */
export function createBridgeLayer(world: PhysicsWorld): BridgeLayer {
  let descriptors: readonly BridgeCollider[] = [];
  const active = new Map<string, RigidBody>();
  const lastFocus = new THREE.Vector3(Infinity, 0, Infinity);
  const clear = () => {
    world.removeLayer('bridges');
    active.clear();
  };
  return {
    setColliders(next) {
      if (next === descriptors) return;
      clear();
      descriptors = next;
      lastFocus.set(Infinity, 0, Infinity);
    },
    update(focus) {
      if (Math.hypot(focus.x - lastFocus.x, focus.z - lastFocus.z) < 15) return;
      lastFocus.copy(focus);
      for (const frame of descriptors) {
        const distance = Math.hypot(frame.position.x - focus.x, frame.position.z - focus.z);
        const reach = frame.halfExtents.length();
        const current = active.get(frame.id);
        if (current) {
          if (distance > 180 + reach) {
            world.removeBody(current);
            active.delete(frame.id);
          }
        } else if (distance < 140 + reach) {
          const e = frame.halfExtents;
          const body = createBody({
            id: frame.id, type: 'static', position: frame.position, quaternion: frame.quaternion,
            colliders: [collider(box(e.x, e.y, e.z))], friction: 0.8, restitution: 0.02,
            userData: { layer: 'bridges', category: CATEGORY_BUILDINGS, mask: CATEGORY_ALL },
          });
          active.set(frame.id, body);
          world.addBody(body);
        }
      }
    },
    dispose() { clear(); descriptors = []; },
  };
}
