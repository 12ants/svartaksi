import * as THREE from 'three';

import {
  INSPECTION_USER_DATA_KEY,
  type WorldInspectionRecord,
} from '../world/inspection';

export interface InspectionTarget {
  object: THREE.Object3D;
  records: WorldInspectionRecord | WorldInspectionRecord[];
}

export function recordForIntersection(
  intersection: THREE.Intersection,
): WorldInspectionRecord | null {
  const records = intersection.object.userData[INSPECTION_USER_DATA_KEY] as
    | WorldInspectionRecord
    | WorldInspectionRecord[]
    | undefined;
  if (!records) return null;
  if (!Array.isArray(records)) return records;
  if (Number.isInteger(intersection.instanceId)) {
    return records[intersection.instanceId as number] ?? null;
  }
  // Merged per-material meshes (e.g. roads — see threeWorld.ts's road merge) carry one
  // record per triangle instead of one per InstancedMesh instance, since there's no
  // instance to index by.
  if (Number.isInteger(intersection.faceIndex)) {
    return records[intersection.faceIndex as number] ?? null;
  }
  return null;
}

/**
 * The geometry an inspection highlight outline should draw. Usually just the hit
 * object's own geometry, but a merged per-material mesh (see threeWorld.ts's road
 * merge) holds every road sharing that material in one buffer, so highlighting it
 * whole would outline the entire road network instead of the one road the player
 * pointed at. This narrows that case to the hit road's contiguous triangle range via a
 * `drawRange` over the *same* attribute buffers — no data copy, and mutating the
 * returned geometry's drawRange never touches the source mesh's own geometry, since
 * drawRange lives on the geometry instance rather than the shared attribute arrays.
 */
export function highlightGeometryForIntersection(intersection: THREE.Intersection): THREE.BufferGeometry {
  const source = (intersection.object as THREE.Mesh).geometry;
  const records = intersection.object.userData[INSPECTION_USER_DATA_KEY];
  if (
    intersection.object instanceof THREE.InstancedMesh
    || !Array.isArray(records)
    || !Number.isInteger(intersection.faceIndex)
  ) {
    return source;
  }
  const faceIndex = intersection.faceIndex as number;
  const record = records[faceIndex];
  let start = faceIndex;
  while (start > 0 && records[start - 1] === record) start -= 1;
  let end = faceIndex;
  while (end < records.length - 1 && records[end + 1] === record) end += 1;
  const partial = new THREE.BufferGeometry();
  partial.index = source.index;
  for (const name in source.attributes) partial.setAttribute(name, source.attributes[name]);
  partial.setDrawRange(start * 3, (end - start + 1) * 3);
  return partial;
}
