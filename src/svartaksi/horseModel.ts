/**
 * The horse: a skinned GLTF model (`src/models/horse.glb`) driven by `horseBody.ts`'s
 * gait/turn state. Loading mirrors `blobModel.ts` — async GLTF decode, caller adds
 * `group` to the scene and drives its transform from the physics-free horse state.
 *
 * Unlike the blob asset, `horse.glb` is not Draco-compressed (checked its glTF JSON
 * chunk directly: no `KHR_draco_mesh_compression` in `extensionsUsed`), so no DRACOLoader
 * is wired up here — adding one for an uncompressed asset would just be dead code.
 *
 * The model's raw geometry is authored in centimetres (~183cm tall, feet ~0.8cm above
 * its origin) rather than metres like the rest of this project's assets, hence
 * `HORSE_MODEL_SCALE`. It ships a single animation clip (`horse_A_`) rather than
 * separate idle/walk/trot/canter clips, so playback is driven by scrubbing that one
 * clip's rate with gait speed rather than crossfading between named clips.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_URL = new URL('../models/horse.glb', import.meta.url).href;

/** cm -> m. */
const HORSE_MODEL_SCALE = 0.01;
/** The model's feet sit ~0.8cm above its own origin; negligible once scaled to metres,
 * so no vertical correction is applied on top of the uniform scale. */
const HORSE_MODEL_FOOT_OFFSET_Y = 0;

/** Playback speed of the `horse_A_` clip at a full canter, in cycles/second. Slower
 * gaits scrub the same clip proportionally slower rather than switching clips, since
 * there is only the one. Tuned by ear against `HORSE.gaitSpeedMps.canter`, not derived
 * from the clip's authored stride length (the asset carries no stride-distance data). */
const CANTER_CYCLES_PER_SECOND = 1.6;

export interface HorseModel {
  /** Add this to the scene; driven by the caller each frame from `HorseState`. */
  group: THREE.Group;
  /** Advances the animation to match `speedMps` (0 = fully paused on its rest frame,
   * scales up towards `CANTER_CYCLES_PER_SECOND` at full canter speed). */
  update(dt: number, speedMps: number): void;
  dispose(): void;
}

export function loadHorseModel(): Promise<HorseModel> {
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.load(MODEL_URL, (gltf) => {
      const model = gltf.scene;
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      model.scale.setScalar(HORSE_MODEL_SCALE);
      model.position.y = HORSE_MODEL_FOOT_OFFSET_Y;

      const group = new THREE.Group();
      group.name = 'horse';
      group.add(model);

      const mixer = new THREE.AnimationMixer(model);
      const clip = gltf.animations[0] ?? null;
      const action = clip ? mixer.clipAction(clip) : null;
      action?.play();
      // Scrubbed by hand via `update`, not left to run at the clip's authored rate.
      action?.setEffectiveTimeScale(0);

      const canterSeconds = clip && clip.duration > 0
        ? clip.duration / CANTER_CYCLES_PER_SECOND
        : null;

      resolve({
        group,
        update(dt, speedMps) {
          if (!action || !canterSeconds) return;
          const canterMps = 7.5; // matches HORSE.gaitSpeedMps.canter in gameplayConfig.ts
          const cyclesPerSecond = (speedMps / canterMps) * (1 / canterSeconds);
          mixer.update(dt);
          if (speedMps <= 0) return;
          action.time = (action.time + dt * cyclesPerSecond * canterSeconds) % action.getClip().duration;
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
