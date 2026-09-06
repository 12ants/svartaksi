/**
 * The bus's outside: an authored GLB body (`bus1.glb`) in place of the procedural shell.
 *
 * The procedural bus is still here and still builds everything the game *drives* — the
 * saloon floor and seats the rider walks between, the doors, the destination display, the
 * next-stop signs, the cab. What this module replaces is only the skin: the panels,
 * glazing and running gear a player sees from the pavement, which is exactly the part a
 * modelled asset does better than two hundred lines of boxes.
 *
 * Two decisions worth knowing about, both forced by how the asset is authored:
 *
 * - **It is fitted to `BUS_DIMENSIONS`, not the other way round.** The sheet in
 *   busGeometry.ts is the contract the route profiler, the suspension, the door
 *   placement, the collision envelope and a dozen tests all agree on, and the asset is
 *   within a few per cent of it in every axis (10.25m against 11, 2.57m of body width
 *   against 2.6, 3.14m tall against 3.06). So the shell is scaled per-axis onto the
 *   sheet. The distortion is under 8% and invisible; the alternative — re-deriving the
 *   sheet from the asset — would move the wheelbase, and with it the turning circle every
 *   route was profiled against.
 * - **Its wheels are split back out of it.** The asset is exported one mesh per material,
 *   so a wheel is not a node you can rotate — but it is still a *place*, and
 *   busShellWheels.ts lifts the four wheels out by measured cylinder and hangs each one
 *   off its own steer and roll pivot. The procedural wheels stay hidden and stay driven,
 *   so a session that cannot fetch the asset still has a bus with turning wheels.
 *
 * The shell's own group carries no transform. The fit scale sits one level down, on the
 * body, because the wheels have to rotate outside it: a rotation inside a non-uniform
 * scale is a shear, and a wheel steered under this one would go visibly elliptical.
 */
import * as THREE from 'three';
import { gltfLoader } from './gltfLoaders';
import { findMeshesByMaterialName } from './glbParts';
import { BUS_DIMENSIONS } from './busGeometry';
import {
  BUS_SHELL_WHEEL_HUBS,
  extractBusShellWheels,
  type BusShellWheel,
  type BusShellWheelHub,
} from './busShellWheels';

const MODEL_URL = new URL('../models/bus1.glb', import.meta.url).href;

/**
 * The asset's own overall size, in metres, measured from its accessor bounds.
 *
 * `width` is the body's width without the mirrors: the widest mesh in the file spans
 * 3.15m, but that is the mirror arms, and scaling a bus so its mirrors match another
 * bus's body width would leave the body 20% too narrow.
 */
export const BUS_ASSET_SIZE = { width: 2.57, height: 3.14, length: 10.25 } as const;

/** Per-axis scale that puts the asset on the approved dimension sheet. */
export function busShellScale(): THREE.Vector3 {
  return new THREE.Vector3(
    BUS_DIMENSIONS.width / BUS_ASSET_SIZE.width,
    BUS_DIMENSIONS.height / BUS_ASSET_SIZE.height,
    BUS_DIMENSIONS.length / BUS_ASSET_SIZE.length,
  );
}

export interface BusShell {
  group: THREE.Group;
  /** The four authored wheels, on their own pivots. `applyBusShell` keeps hold of these
   * so the existing bus setters can drive them. */
  wheels: readonly BusShellWheel[];
  /** The asset's lamp materials, by the names it gives them. Present so the runtime's
   * night/brake/indicator states can drive the modelled lenses the way they drove the
   * procedural ones; absent entries are tolerated, since a re-export may rename them. */
  lamps: {
    head: THREE.MeshStandardMaterial | null;
    tail: THREE.MeshStandardMaterial | null;
    reverse: THREE.MeshStandardMaterial | null;
    indicator: THREE.MeshStandardMaterial | null;
  };
  dispose(): void;
}

/** A shell built from an already-loaded scene: the scene graph, without the loader. */
export interface AssembledBusShell {
  group: THREE.Group;
  wheels: BusShellWheel[];
  /** Everything the split created or orphaned, for the shell to dispose at teardown. */
  geometries: THREE.BufferGeometry[];
}

/**
 * Builds the shell's scene graph around a loaded body, wheels and all.
 *
 * Split out of `loadBusShell` because everything interesting here is arithmetic on a scene
 * graph — where the scale sits, where the wheels end up — and none of it needs a loader, a
 * network or a GPU to be wrong. `loadBusShell` is then the thin part: fetch, drop the
 * interior, call this.
 *
 * The scale goes on the body rather than on `group`, so the wheel pivots stay in unscaled
 * bus space. See the module comment for why that matters.
 */
export function assembleBusShell(
  root: THREE.Object3D,
  scale: THREE.Vector3,
  hubs: readonly BusShellWheelHub[] = BUS_SHELL_WHEEL_HUBS,
): AssembledBusShell {
  const extraction = extractBusShellWheels(root, scale, hubs);

  const body = new THREE.Group();
  body.name = 'bus:shell-body';
  body.scale.copy(scale);
  body.add(root);

  const group = new THREE.Group();
  group.name = 'bus:shell';
  group.add(body, extraction.group);

  return {
    group,
    wheels: extraction.wheels,
    geometries: [...extraction.geometries, ...extraction.orphanedGeometries],
  };
}

/**
 * Builds the shell from an already-loaded scene, and takes ownership of everything in it.
 *
 * The asset's interior is dropped: the saloon the player actually walks around in is the
 * procedural one, built to the aisle and seat colliders the rider is clamped against, and
 * two interiors in one bus would leave the player wading through baked seats. It goes
 * before the wheel split so the split never has to reason about geometry that is on its
 * way out.
 *
 * **Ownership is taken before anything is detached.** Removing an object from a scene does
 * not release its geometry or its material, so a shell that disposed by traversing itself
 * would leak exactly what it threw away — the interior, and the rim mesh the wheel split
 * empties. The resources are therefore collected from the whole loaded scene first, the
 * split's own geometries are added to the same set, and teardown walks the set rather than
 * the tree. Nothing is released while the shell is being built: an interior material may
 * be an exterior material too, and disposing it on the way past would take the body's
 * paint with it. See https://threejs.org/manual/en/how-to-dispose-of-objects.html.
 *
 * Rejects an asset whose wheels it cannot find: `busShellWheels` throws rather than
 * installing a bus with holes where its running gear was, and the runtime's `.catch`
 * keeps the whole procedural bus — which does have turning wheels.
 */
export function createBusShell(
  root: THREE.Object3D,
  hubs: readonly BusShellWheelHub[] = BUS_SHELL_WHEEL_HUBS,
): BusShell {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });

  for (const mesh of findMeshesByMaterialName(root, 'interior')) mesh.removeFromParent();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });

  const lamps = {
    head: lampMaterial(root, 'headlght'),
    tail: lampMaterial(root, 'rearlght'),
    reverse: lampMaterial(root, 'backlght'),
    indicator: lampMaterial(root, 'turnlght'),
  };

  const assembled = assembleBusShell(root, busShellScale(), hubs);
  for (const geometry of assembled.geometries) geometries.add(geometry);

  let disposed = false;
  return {
    group: assembled.group,
    wheels: assembled.wheels,
    lamps,
    dispose() {
      if (disposed) return;
      disposed = true;
      assembled.group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/**
 * Fetches the asset and builds the shell from it.
 *
 * Deliberately thin: everything that can be wrong about the shell — where the scale sits,
 * which triangles are a wheel, which resources it owns — lives in `createBusShell` and
 * `assembleBusShell`, where a test can reach it without a network or a GPU.
 *
 * Note that the asset carries **no textures**, so nothing here scans for them. If a future
 * export brings some, they need adding to the owned set explicitly; a generic material
 * walk that guesses at texture-shaped properties would be a solution to a problem this
 * asset does not have.
 */
export async function loadBusShell(): Promise<BusShell> {
  const gltf = await gltfLoader().loadAsync(MODEL_URL);
  return createBusShell(gltf.scene);
}

/** The first standard material under `root` with this name, prepared to glow. */
function lampMaterial(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial | null {
  const mesh = findMeshesByMaterialName(root, name)[0];
  if (!mesh) return null;
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
  if (!(material instanceof THREE.MeshStandardMaterial)) return null;
  // The asset's lamps are painted, not lit: they carry a base colour and no emissive at
  // all, so a lamp "coming on" would do nothing until it has something to emit. Seeded
  // from the base colour so a red lens glows red, and left at zero intensity — every
  // lamp is off until the runtime says otherwise.
  material.emissive = new THREE.Color().copy(material.color);
  material.emissiveIntensity = 0;
  material.toneMapped = false;
  return material;
}

/**
 * Sets one lamp's brightness, tolerating a lamp the asset does not have.
 *
 * The runtime drives these every frame from the same state that drove the procedural
 * lenses (night factor, braking, reversing, indicator phase), so this is the whole of the
 * binding between the two.
 */
export function setLampIntensity(material: THREE.MeshStandardMaterial | null, intensity: number): void {
  if (material) material.emissiveIntensity = Math.max(0, intensity);
}
