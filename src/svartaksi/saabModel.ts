/**
 * The Saab 90: the black taxi the game is named for, and the car the player drives.
 *
 * The asset is an authored GLB rather than the procedural box-and-cylinder car that
 * stands in for it, which brings two problems this module exists to solve.
 *
 * **It is exported by material, not by part.** Six meshes share one material, and the two
 * called `Cylinder…` are each an entire axle — both wheels of it welded into one
 * geometry. Nothing in the file can be rotated to make a wheel turn. `glbParts.ts` splits
 * each axle at the gap between its wheels and hands back four parts with their own
 * pivots, which is what makes the car's wheels steer and roll rather than skate.
 *
 * **It is authored Z-up and centred on its own middle**, as 3ds Max exports are. Every
 * other body in this game stands on y=0 facing +Z. Rather than carry that discrepancy
 * into the runtime as an extra parent transform to remember, the correction is baked into
 * the geometry once at load: after `orientToCarSpace` the vertices themselves are in car
 * space, so the wheels' measured pivots are directly the numbers the physics wheels use.
 *
 * The measurements below were taken from the asset's own accessor bounds, not guessed —
 * see `SAAB_DIMENSIONS`. The physics car is built to them (`carPhysics.ts`), so what you
 * collide with is the shape you can see.
 */
import * as THREE from 'three';
import { gltfLoader } from './gltfLoaders';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { splitGeometryAlongAxis, type SplitPart } from './glbParts';

const MODEL_URL = new URL('../models/saab90.glb', import.meta.url).href;

/**
 * Measured from `saab90.glb`'s accessor bounds, in the asset's own Z-up frame, then
 * expressed here in car space (metres, +Z forward, y=0 on the road).
 *
 * A real Saab 90 is 4.68m long on a 2.52m wheelbase; this model reads 4.92 and 2.66,
 * which is close enough that the numbers below are used as-is rather than rescaled — the
 * car should match its own asset, not a brochure.
 */
export const SAAB_DIMENSIONS = {
  length: 4.92,
  width: 1.98,
  height: 1.55,
  /** Half-height: the asset is centred vertically, so this is also the lift to the road. */
  groundOffset: 0.774,
  wheelRadius: 0.355,
  /** Front and rear axle centres in car space. Their midpoint is 0.07 ahead of the body's
   * centre, which is left in rather than smoothed away — it is where the axles are. */
  frontAxleZ: 1.4,
  rearAxleZ: -1.26,
  /** Half-track, refined at load from the split wheels' own pivots. */
  halfTrack: 0.86,
} as const;

/** Half the wheelbase, and the axle midpoint the physics chassis is built around. */
export const SAAB_HALF_WHEELBASE = (SAAB_DIMENSIONS.frontAxleZ - SAAB_DIMENSIONS.rearAxleZ) / 2;

/**
 * The gap, in metres, that separates one wheel of an axle from the other when the axle's
 * triangles are sorted across the car. The two wheels sit about 1.6m apart and are each
 * about 0.2m wide, so anything comfortably between those separates them; half a metre
 * leaves room for a tyre modelled fatter than this one without ever splitting a single
 * wheel in two.
 */
const WHEEL_SPLIT_GAP = 0.5;

/**
 * Matrix taking the asset's Z-up, origin-centred vertices into car space.
 *
 * Rx(-90°) stands the model up; Ry(180°) turns it to face +Z (the front is the end with
 * the shorter overhang beyond its axle, which is the front of any front-engined saloon);
 * the translation drops it onto the road.
 */
export function orientToCarSpace(): THREE.Matrix4 {
  const standUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const faceForward = new THREE.Matrix4().makeRotationY(Math.PI);
  const toGround = new THREE.Matrix4().makeTranslation(0, SAAB_DIMENSIONS.groundOffset, 0);
  return toGround.multiply(faceForward).multiply(standUp);
}

export interface SaabShell {
  /** Every non-wheel mesh, merged into one child group in car space. */
  body: THREE.Group;
  /** Front-left, front-right, rear-left, rear-right — the order `carPhysics` builds its
   * struts in, so index i is the same wheel in both. */
  wheels: [SplitPart, SplitPart, SplitPart, SplitPart];
  /** The half-track actually measured from the split wheels, which is what the visible
   * wheels are placed at. */
  halfTrack: number;
}

/** Sorts four wheel parts into front-left, front-right, rear-left, rear-right. */
export function orderWheels(parts: SplitPart[]): [SplitPart, SplitPart, SplitPart, SplitPart] {
  if (parts.length !== 4) {
    throw new Error(`expected 4 wheels from the Saab's two axles, got ${parts.length}`);
  }
  const sorted = [...parts].sort((a, b) => (b.pivot.z - a.pivot.z) || (a.pivot.x - b.pivot.x));
  const front = sorted.slice(0, 2).sort((a, b) => a.pivot.x - b.pivot.x);
  const rear = sorted.slice(2).sort((a, b) => a.pivot.x - b.pivot.x);
  return [front[0], front[1], rear[0], rear[1]];
}

/**
 * Loads the asset and returns it already in car space, split into a body and four wheels.
 *
 * Merging: the body is five meshes sharing a single material, so they are concatenated
 * into one geometry — five draw calls a frame for one car is five too many when the same
 * pixels come out of one, and the merge is free because there is nothing to animate
 * between them.
 */
export async function loadSaabShell(): Promise<SaabShell> {
  const gltf = await gltfLoader().loadAsync(MODEL_URL);
  const correction = orientToCarSpace();

  const bodyMeshes: THREE.Mesh[] = [];
  const axleMeshes: THREE.Mesh[] = [];
  gltf.scene.updateWorldMatrix(true, true);
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // Bake the node's own transform and the Z-up correction into the vertices, so every
    // geometry below is directly comparable and directly placeable.
    object.geometry = object.geometry.clone();
    object.geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(correction, object.matrixWorld));
    // The axles are the only meshes wider than they are long: a cylinder lying across the
    // car. Detected by shape rather than by name so a re-export that renames the nodes
    // still yields a car with wheels.
    (isAxleGeometry(object.geometry) ? axleMeshes : bodyMeshes).push(object);
  });

  const wheelParts = axleMeshes.flatMap((mesh) =>
    splitGeometryAlongAxis(mesh.geometry, 'x', WHEEL_SPLIT_GAP));
  const wheels = orderWheels(wheelParts);

  const body = new THREE.Group();
  body.name = 'saab:body';
  for (const panel of mergePanels(bodyMeshes)) {
    panel.castShadow = true;
    panel.receiveShadow = true;
    body.add(panel);
  }

  const halfTrack = wheels.reduce((sum, wheel) => sum + Math.abs(wheel.pivot.x), 0) / wheels.length;

  return { body, wheels, halfTrack };
}

/**
 * Concatenates the body panels that share a material into one mesh each.
 *
 * Five draw calls a frame for one stationary shape is four too many, and there is nothing
 * to animate between the panels, so the merge costs nothing. It is attempted rather than
 * assumed: `mergeGeometries` returns null when the inputs disagree about their attributes,
 * and a re-export that adds a UV set to some panels and not others should degrade to the
 * unmerged car rather than to no car.
 */
export function mergePanels(meshes: THREE.Mesh[]): THREE.Mesh[] {
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const bucket = byMaterial.get(material);
    if (bucket) bucket.push(mesh);
    else byMaterial.set(material, [mesh]);
  }

  const merged: THREE.Mesh[] = [];
  for (const [material, group] of byMaterial) {
    if (group.length === 1) {
      merged.push(new THREE.Mesh(group[0].geometry, material));
      continue;
    }
    const geometry = mergeGeometries(group.map((mesh) => mesh.geometry), false);
    if (geometry) merged.push(new THREE.Mesh(geometry, material));
    else for (const mesh of group) merged.push(new THREE.Mesh(mesh.geometry, material));
  }
  return merged;
}

/**
 * Whether a geometry is one of the axles: a bar lying across the car, wider in x than it
 * is long in z. Every body panel of a saloon is the other way round.
 */
export function isAxleGeometry(geometry: THREE.BufferGeometry): boolean {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return false;
  const size = new THREE.Vector3();
  box.getSize(size);
  return size.x > size.z * 1.5 && size.y < SAAB_DIMENSIONS.wheelRadius * 2.4;
}
