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
 * - **Its wheels do not turn.** The asset is exported one mesh per material, so a wheel
 *   is not a separable object: the rims are in one mesh with every other white part, the
 *   tyres in another with every other black one. The procedural wheels that *do* steer
 *   and roll sit at the sheet's axle positions rather than the asset's wheel arches, so
 *   showing both would put eight wheels on a six-wheeled bus. The modelled ones win on
 *   looks and the animation is lost with them; `setBusSteer`/`setBusWheelRoll` keep
 *   driving the hidden groups, so restoring it is a matter of splitting the asset, not of
 *   rebuilding the runtime.
 */
import * as THREE from 'three';
import { gltfLoader } from './gltfLoaders';
import { findMeshesByMaterialName } from './glbParts';
import { BUS_DIMENSIONS } from './busGeometry';

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

/**
 * Loads the shell, fitted and ready to add to the bus group.
 *
 * The asset's interior is dropped: the saloon the player actually walks around in is the
 * procedural one, built to the aisle and seat colliders the rider is clamped against, and
 * two interiors in one bus would leave the player wading through baked seats.
 */
export async function loadBusShell(): Promise<BusShell> {
  const gltf = await gltfLoader().loadAsync(MODEL_URL);
  const root = gltf.scene;

  for (const mesh of findMeshesByMaterialName(root, 'interior')) mesh.removeFromParent();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });

  const group = new THREE.Group();
  group.name = 'bus:shell';
  group.scale.copy(busShellScale());
  group.add(root);

  const lamps = {
    head: lampMaterial(root, 'headlght'),
    tail: lampMaterial(root, 'rearlght'),
    reverse: lampMaterial(root, 'backlght'),
    indicator: lampMaterial(root, 'turnlght'),
  };

  return {
    group,
    lamps,
    dispose() {
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
    },
  };
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
