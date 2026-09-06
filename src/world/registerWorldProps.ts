/**
 * Turns each batch of instanced street furniture into physics props.
 *
 * Deliberately outside the batch builders themselves. Those functions have one job — turn
 * placements into instanced geometry — and they are the most heavily exercised code in
 * threeWorld; threading a physics registry through their internals would put collision
 * concerns in the middle of every one of them. Instead each builder's output is read back
 * here, which works because their indexing is a documented, regular property of how they
 * are written: every part mesh in a batch carries the same number of instances per item,
 * laid out item-major.
 *
 * The one exception is trees, whose two crown meshes each hold only the subset of trees
 * of that leaf type, so their instance indices run independently of the trunk's. That is
 * reconstructed explicitly below.
 */
import * as THREE from 'three';
import { createPropRegistry, type PropEntry, type WorldProp } from './propRegistry';
import {
  benchColliders,
  busStopColliders,
  mailboxColliders,
  mastColliders,
  smallFurnitureColliders,
  streetLightColliders,
  trafficSignalColliders,
  treeColliders,
  type PropKind,
} from './propProfiles';
import type { Collider } from '../physics/types';
import type { LampPlacement } from './streetLights';
import type { MailboxPlacement } from './mailboxes';
import type { BusStopPlacement } from './busStops';
import type { TreePlacement } from './vegetation';
import type { TrafficSignal } from '../svartaksi/trafficLights';
import type { WorldObject } from './types';
import { withinLocalRadius } from './geo';

/** Anything past this from the streaming anchor is not given a collision frame. Nothing
 * can reach it before the world is rebuilt around a new anchor anyway, and trees alone
 * run to thousands per snapshot. */
export const PROP_REGISTRATION_RADIUS = 320;

/** Anything with a place in the world. `y` is optional because most batches are planted
 * on the ground and never had one; a placement that carries it (a lamp on a bridge deck)
 * gets its collision frame at the height it is actually drawn at rather than at zero. */
type Placed = { x: number; z: number; y?: number };

function instancedChildren(group: THREE.Object3D): THREE.InstancedMesh[] {
  return group.children.filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh);
}

function withinRadius(item: Placed, anchorX: number, anchorZ: number): boolean {
  return withinLocalRadius(item, { x: anchorX, z: anchorZ }, PROP_REGISTRATION_RADIUS);
}

/**
 * The common case: every mesh in `group` holds the same number of instances per item,
 * laid out item-major, so item `i` owns indices `i * perItem` upwards in each of them.
 */
function collectUniform<T extends Placed>(
  meshes: readonly THREE.InstancedMesh[],
  items: readonly T[],
  describe: (item: T, index: number) => Omit<PropEntry, 'parts'> | null,
): WorldProp[] {
  if (!meshes.length || !items.length) return [];
  // One value per mesh, not one per item per mesh: it depends only on the batch.
  const instancesPerItem = meshes.map((mesh) => Math.max(1, Math.floor(mesh.count / items.length)));
  const registry = createPropRegistry();
  for (let index = 0; index < items.length; index += 1) {
    const base = describe(items[index], index);
    if (!base) continue;
    const parts: PropEntry['parts'] = [];
    for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
      const mesh = meshes[meshIndex];
      const perItem = instancesPerItem[meshIndex];
      for (let slot = 0; slot < perItem; slot += 1) {
        const instance = index * perItem + slot;
        if (instance < mesh.count) parts.push({ mesh, index: instance });
      }
    }
    if (parts.length) registry.add({ ...base, parts });
  }
  return registry.finalize();
}

/**
 * The four batches that follow one layout: a fixed number of instances per placement, in
 * placement order, and a collision frame that is the same for every instance of the kind.
 * They differed only in the kind's name and its collider factory, so they are one factory
 * rather than four bodies that have to be kept in step by hand.
 */
function uniformProps<T extends Placed & { yaw: number }>(kind: PropKind, colliders: () => Collider[]) {
  return (
    group: THREE.Object3D,
    items: readonly T[],
    anchorX: number,
    anchorZ: number,
  ): WorldProp[] => collectUniform(instancedChildren(group), items, (item, index) =>
    withinRadius(item, anchorX, anchorZ) ? {
      id: `${kind}:${index}:${item.x.toFixed(2)}:${item.z.toFixed(2)}`,
      kind,
      x: item.x, y: item.y ?? 0, z: item.z, yaw: item.yaw,
      colliders: colliders(),
    } : null);
}

export const streetLightProps = uniformProps<LampPlacement>('street-light', streetLightColliders);
export const trafficSignalProps = uniformProps<TrafficSignal>('traffic-signal', trafficSignalColliders);
export const mailboxProps = uniformProps<MailboxPlacement>('mailbox', mailboxColliders);
export const busStopProps = uniformProps<BusStopPlacement>('bus-stop', busStopColliders);

export function treeProps(
  group: THREE.Object3D,
  trees: readonly TreePlacement[],
  anchorX: number,
  anchorZ: number,
): WorldProp[] {
  const meshes = new Map(instancedChildren(group).map((mesh) => [mesh.name, mesh]));
  const trunks = meshes.get('world:trees:trunks') ?? null;
  const crowns: Record<TreePlacement['kind'], THREE.InstancedMesh | null> = {
    needleleaf: meshes.get('world:trees:needleleaf') ?? null,
    broadleaf: meshes.get('world:trees:broadleaf') ?? null,
  };
  const nextCrownIndex: Record<TreePlacement['kind'], number> = { needleleaf: 0, broadleaf: 0 };

  const registry = createPropRegistry();
  for (let index = 0; index < trees.length; index += 1) {
    const tree = trees[index];
    const crownIndex = nextCrownIndex[tree.kind];
    nextCrownIndex[tree.kind] += 1;
    if (!withinRadius(tree, anchorX, anchorZ)) continue;
    const parts: PropEntry['parts'] = [];
    if (trunks && index < trunks.count) parts.push({ mesh: trunks, index });
    const crown = crowns[tree.kind];
    if (crown && crownIndex < crown.count) parts.push({ mesh: crown, index: crownIndex });
    if (!parts.length) continue;
    registry.add({
      id: `tree:${index}:${tree.x.toFixed(2)}:${tree.z.toFixed(2)}`,
      kind: 'tree',
      x: tree.x,
      // Trees stand on top of whatever landuse polygon they grow out of.
      y: tree.y,
      z: tree.z,
      yaw: tree.yaw,
      colliders: treeColliders(tree.height),
      parts,
    });
  }
  return registry.finalize();
}

/** Each part of a kind uses the same filtered object order, so a dislodged bin's lid
 * must claim the same instance index as its body. */
interface ObjectDefinition {
  /** Mirrors one entry of createObjectInstances' own definition list, including the
   * order of `kinds` — the mesh is named after the first of them. */
  kinds: readonly string[];
  propKind: PropKind;
  colliders: () => Collider[];
}

const OBJECT_DEFINITIONS: readonly ObjectDefinition[] = [
  { kinds: ['fountain', 'drinking_water'], propKind: 'fountain', colliders: () => smallFurnitureColliders(1.25, 0.58) },
  { kinds: ['bench'], propKind: 'bench', colliders: benchColliders },
  { kinds: ['street_lamp'], propKind: 'street-light', colliders: () => streetLightColliders(4.2) },
  {
    kinds: ['artwork', 'statue', 'sculpture'],
    propKind: 'small-furniture',
    colliders: () => smallFurnitureColliders(0.45, 1.8),
  },
  { kinds: ['waste_basket'], propKind: 'small-furniture', colliders: () => smallFurnitureColliders(0.27, 0.89) },
  { kinds: ['flagpole', 'mast'], propKind: 'mast', colliders: () => mastColliders(8) },
];

export function mappedObjectProps(
  group: THREE.Object3D,
  objects: readonly WorldObject[],
  anchorX: number,
  anchorZ: number,
  groundAt: (x: number, z: number) => number = () => 0,
): WorldProp[] {
  const meshes = instancedChildren(group);
  const props: WorldProp[] = [];
  for (const definition of OBJECT_DEFINITIONS) {
    const name = `world:objects:${definition.kinds[0]}`;
    const parts = meshes.filter((mesh) => mesh.name === name || mesh.name.startsWith(`${name}:`));
    if (!parts.length) continue;
    const batch = objects
      .filter((object) => definition.kinds.includes(object.kind))
      .map((object) => ({ id: object.id, x: object.point.x, z: object.point.z }));
    props.push(...collectUniform(parts, batch, (item) => withinRadius(item, anchorX, anchorZ) ? {
      id: `object:${item.id}`,
      kind: definition.propKind,
      x: item.x, y: groundAt(item.x, item.z), z: item.z, yaw: 0,
      colliders: definition.colliders(),
    } : null));
  }
  return props;
}
