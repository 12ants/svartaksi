/**
 * The "blob" playable form: a skinned GLTF character (idle/walk/run) borrowed from the
 * docs/misc/blobby prototype, as an alternative to the on-foot capsule. Unlike every
 * other body in this file it is an authored asset rather than procedural geometry, so
 * loading is async — `loadBlobModel` resolves once the GLB (Draco-compressed) has been
 * fetched and decoded, and the caller is responsible for not showing `group` before then.
 */
import * as THREE from 'three';
import { gltfLoader } from './gltfLoaders';

import { BLOB_MODEL } from './gameplayConfig';

const CLIP_NAMES = ['idle', 'walk', 'run'] as const;
export type BlobAnimationName = typeof CLIP_NAMES[number];

export interface BlobModel {
  /** Add this to the scene; it is the thing whose position/rotation the runtime drives.
   * Starts empty — the loaded character is parented in once decoding finishes, so callers
   * that add it to the scene before the promise resolves see it grow into place. */
  group: THREE.Group;
  /** Crossfades to the named clip; a no-op if already playing it or if the clip is
   * missing from this asset. */
  setAnimation(name: BlobAnimationName): void;
  /** Advances the animation mixer. The runtime owns the fixed-tick `dt`, same as every
   * other body's movement. */
  update(dt: number): void;
  dispose(): void;
}

const MODEL_URL = new URL('../models/blobCharacter.glb', import.meta.url).href;

export function loadBlobModel(): Promise<BlobModel> {
  // One decoder for the process, per the DRACOLoader docs' own recommendation — now
  // shared with the model library's spawns rather than private to this module.
  const loader = gltfLoader();

  return new Promise((resolve, reject) => {
    loader.load(MODEL_URL, (gltf) => {
      const character = gltf.scene;
      character.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      character.scale.setScalar(BLOB_MODEL.scale);
      character.position.y = BLOB_MODEL.footOffsetY;

      const group = new THREE.Group();
      group.name = 'blob';
      group.add(character);

      const mixer = new THREE.AnimationMixer(character);
      const actions = new Map<BlobAnimationName, THREE.AnimationAction>();
      for (const name of CLIP_NAMES) {
        const clip = THREE.AnimationClip.findByName(gltf.animations, name);
        if (clip) actions.set(name, mixer.clipAction(clip));
      }
      let current: BlobAnimationName | null = null;
      actions.get('idle')?.play();
      current = actions.has('idle') ? 'idle' : null;

      resolve({
        group,
        setAnimation(name) {
          if (name === current || !actions.has(name)) return;
          const previous = current ? actions.get(current) : undefined;
          previous?.fadeOut(0.24);
          actions.get(name)!.reset().fadeIn(0.24).play();
          current = name;
        },
        update(dt) {
          mixer.update(dt);
        },
        dispose() {
          mixer.stopAllAction();
        },
      });
    }, undefined, (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
