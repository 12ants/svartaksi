/**
 * Spawning a GLB from the model library (`world/modelLibrary.ts`) into the live scene.
 *
 * The three.js half of that feature: fetch, normalise, and hand back a group the runtime
 * can stand on the ground. The catalogue, the URLs and the fit arithmetic are all pure and
 * live next door; what is here is only the part that needs a scene.
 *
 * Spawned models are **decoration, not world data**. They are not part of a `WorldData`
 * snapshot, so a world rebuild does not remove them and they carry no collision frame —
 * you can walk through one. That is the honest scope of a browse-and-spawn tool: it is for
 * looking at models in situ, not for authoring a level.
 */
import * as THREE from 'three';
import { gltfLoader } from './gltfLoaders';
import { modelFitTransform, type RemoteModel } from '../world/modelLibrary';

/** Metres the longest side of a spawned model is scaled to — so every spawn lands inside a
 * box this big whatever its shape. Roughly a delivery van: big enough to read from the
 * chase camera, small enough that spawning several does not wall the street in. */
export const SPAWN_TARGET_SIZE = 4;

/** How far in front of the player a spawn lands, in metres — clear of the body itself, and
 * inside the near plane's comfortable range so it is on screen the moment it appears. */
export const SPAWN_FORWARD_DISTANCE = 6;

/**
 * The AABB of `object` expressed in its **parent's** coordinate system.
 *
 * `Box3.setFromObject` gives a world-space box, which is the wrong frame the moment a
 * spawn has been placed somewhere in the world: the fit below sets the object's own
 * position and scale, so it has to be computed in the space those are expressed in. At
 * load time the two frames coincide and either would do; after a re-fit in situ they do
 * not, and using the world box would walk the model off across the map.
 */
export function boxInParentSpace(object: THREE.Object3D): THREE.Box3 {
  object.updateWorldMatrix(true, true);
  const toParent = new THREE.Matrix4();
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    toParent.copy(object.parent.matrixWorld).invert();
  }
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const transform = new THREE.Matrix4();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    // Mirrors what Box3.expandByObject does, and for the same reason: a SkinnedMesh
    // carries its own `boundingBox` that accounts for the skeleton, while its *geometry*
    // box is the raw bind-pose one. Reading the geometry box for a rigged character
    // measured `low-poly_man.glb` at 338m tall instead of its actual size.
    const self = child as unknown as { boundingBox?: THREE.Box3 | null; computeBoundingBox(): void };
    let bounds: THREE.Box3 | null | undefined;
    if (self.boundingBox !== undefined) {
      if (self.boundingBox === null) self.computeBoundingBox();
      bounds = self.boundingBox;
    } else {
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      bounds = child.geometry.boundingBox;
    }
    if (!bounds) return;
    meshBox.copy(bounds).applyMatrix4(transform.multiplyMatrices(toParent, child.matrixWorld));
    box.union(meshBox);
  });
  return box;
}

/**
 * Scales `object` so its longest dimension is `targetSize` and moves it so it is centred
 * horizontally on its parent's origin with its underside exactly at y=0.
 *
 * Idempotent, and safe to re-run after the object's *rotation* changes — which is the
 * point. Tipping a model changes where its underside is,
 * so an orientation change that did not re-fit would leave it floating or sunk. Its own position and scale are reset before
 * measuring so the box is of the model, not of the last fit.
 */
export function fitToGround(object: THREE.Object3D, targetSize: number): void {
  object.position.set(0, 0, 0);
  object.scale.setScalar(1);
  const box = boxInParentSpace(object);
  const fit = modelFitTransform(box.min, box.max, targetSize);
  object.scale.setScalar(fit.scale);
  object.position.set(fit.offsetX, fit.offsetY, fit.offsetZ);
}

export interface SpawnedModel {
  group: THREE.Group;
  /** The catalogue entry this came from, so the runtime can report what it spawned. */
  model: RemoteModel;
  /** Advances any animation the GLB brought with it; a no-op for a static model. */
  update(dt: number): void;
  /**
   * Tips the model a quarter turn about X and re-fits it to the ground.
   *
   * glTF is a Y-up format, but exporters do ship Z-up files — `saab901-astyle` and its
   * kind spawn lying on their end. Nothing in the file says which, and a heuristic that
   * guessed would flip some models right and others wrong, so this is the manual answer:
   * four presses returns you to where you started, and the fit is reapplied each time so
   * the model is always the right size standing on the floor.
   */
  tip(): void;
  /** Which quarter turn about X the model is currently on, 0-3. */
  quarterTurns(): number;
  dispose(): void;
}

/**
 * Loads one model and returns it normalised: its tallest dimension scaled to
 * `SPAWN_TARGET_SIZE`, centred horizontally on the group's origin, and its underside
 * exactly at y=0 — so the caller places it by setting `group.position` to a point on the
 * ground, with no per-model fudging.
 *
 * Any animation clips in the file are played on loop. Most of this library is character
 * models exported mid-action, and a dancing frog standing perfectly still reads as a
 * broken import rather than a static asset.
 */
export function loadSpawnedModel(model: RemoteModel): Promise<SpawnedModel> {
  return new Promise((resolve, reject) => {
    gltfLoader().load(
      model.url,
      (gltf) => {
        const scene = gltf.scene;
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
          }
        });

        const group = new THREE.Group();
        group.name = `spawned:${model.fileName}`;
        group.add(scene);
        // Parented first, then fitted: fitToGround measures in the parent's frame, so the
        // model has to have one before the measurement means anything.
        fitToGround(scene, SPAWN_TARGET_SIZE);

        const mixer = gltf.animations.length ? new THREE.AnimationMixer(scene) : null;
        if (mixer) for (const clip of gltf.animations) mixer.clipAction(clip).play();

        let turns = 0;
        resolve({
          group,
          model,
          update(dt) {
            mixer?.update(dt);
          },
          tip() {
            turns = (turns + 1) % 4;
            scene.rotation.x = (turns * Math.PI) / 2;
            fitToGround(scene, SPAWN_TARGET_SIZE);
          },
          quarterTurns: () => turns,
          dispose() {
            mixer?.stopAllAction();
            group.removeFromParent();
            group.traverse((object) => {
              if (!(object instanceof THREE.Mesh)) return;
              object.geometry.dispose();
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              for (const material of materials) material.dispose();
            });
          },
        });
      },
      undefined,
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}
