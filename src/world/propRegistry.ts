/**
 * The bridge between the world's instanced street furniture and the physics bodies that
 * can knock it over.
 *
 * Everything standing on a pavement here — lamp posts, trees, signal heads, post boxes,
 * shelters — is drawn as instances inside a handful of InstancedMeshes, because that is
 * the only way a district's worth of it costs a handful of draw calls. The catch is that
 * an instance has no object to move: it is sixteen floats in a shared buffer.
 *
 * So each generator registers, per item it places, the (mesh, instance) pairs that make
 * it up, together with the transform it was placed at. `finalize` then measures each
 * part's placement *relative to the item as a whole*, which is what turns a scattered set
 * of instance matrices back into a rigid object: from then on the item can be given any
 * position and orientation and every part follows, still drawn from the same instanced
 * batch it always was. A lamp post lying in the gutter is the same draw call as one
 * standing up.
 */
import * as THREE from 'three';
import type { Collider } from '../physics/types';
import type { PropKind } from './propProfiles';

/** One instance inside one InstancedMesh, and where it sits within its prop. */
export interface PropPart {
  mesh: THREE.InstancedMesh;
  index: number;
  /** The part's placement in the prop's own frame, including any scale it was given. */
  local: THREE.Matrix4;
}

export interface WorldProp {
  id: string;
  kind: PropKind;
  /** Ground-level origin the prop was placed at. */
  position: THREE.Vector3;
  yaw: number;
  /** Physics collision frame, in the prop's own frame with y=0 at its base. */
  colliders: Collider[];
  parts: PropPart[];
}

export interface PropEntry {
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  colliders: Collider[];
  parts: Array<{ mesh: THREE.InstancedMesh; index: number }>;
}

export interface PropRegistry {
  add(entry: PropEntry): void;
  /** Resolves every part's local placement. Call once, after all instance matrices for
   * the batch have been written. */
  finalize(): WorldProp[];
}

export function createPropRegistry(): PropRegistry {
  const entries: PropEntry[] = [];
  return {
    add(entry) {
      entries.push(entry);
    },
    finalize() {
      const props: WorldProp[] = [];
      const base = new THREE.Matrix4();
      const inverse = new THREE.Matrix4();
      const instance = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      for (const entry of entries) {
        const position = new THREE.Vector3(entry.x, entry.y, entry.z);
        quaternion.setFromAxisAngle(_up, entry.yaw);
        base.compose(position, quaternion, scale);
        inverse.copy(base).invert();
        const parts: PropPart[] = [];
        for (const part of entry.parts) {
          part.mesh.getMatrixAt(part.index, instance);
          parts.push({
            mesh: part.mesh,
            index: part.index,
            local: new THREE.Matrix4().multiplyMatrices(inverse, instance),
          });
        }
        props.push({
          id: entry.id,
          kind: entry.kind,
          position,
          yaw: entry.yaw,
          colliders: entry.colliders,
          parts,
        });
      }
      return props;
    },
  };
}

/**
 * Redraws a prop at a new pose. Only the instances belonging to this prop are uploaded —
 * marking the whole matrix buffer dirty would push a five-thousand-tree batch to the GPU
 * every frame one tree happened to be falling over.
 */
export function applyPropTransform(
  prop: WorldProp,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): void {
  _base.compose(position, quaternion, _unitScale);
  for (const part of prop.parts) {
    _world.multiplyMatrices(_base, part.local);
    part.mesh.setMatrixAt(part.index, _world);
    part.mesh.instanceMatrix.addUpdateRange(part.index * 16, 16);
    part.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _base = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _unitScale = new THREE.Vector3(1, 1, 1);
