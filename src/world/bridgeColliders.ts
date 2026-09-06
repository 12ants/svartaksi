import * as THREE from 'three';
import type { LocalPoint } from './types';

export interface BridgeCollider {
  id: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  halfExtents: THREE.Vector3;
}

/** A slab occupies only its own thickness; nothing fills the clearance beneath it. */
export function bridgeDeckColliders(
  roadId: string,
  points: readonly LocalPoint[],
  elevations: readonly number[],
  thickness: readonly number[],
  width: number,
): BridgeCollider[] {
  const result: BridgeCollider[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    const horizontal = Math.hypot(b.x - a.x, b.z - a.z);
    if (horizontal < 1e-6) continue;
    // Short pieces follow a taper without a long box protruding below its shallow end.
    const steps = Math.max(1, Math.ceil(horizontal / 4));
    for (let j = 0; j < steps; j += 1) {
      const t = (j + 0.5) / steps;
      const depth = THREE.MathUtils.lerp(thickness[i], thickness[i + 1], t);
      if (depth < 0.001) continue;
      const rise = elevations[i + 1] - elevations[i];
      const forward = new THREE.Vector3(b.x - a.x, rise, b.z - a.z).normalize();
      const across = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
      const up = new THREE.Vector3().crossVectors(forward, across);
      result.push({
        id: `bridge:${roadId}:deck:${i}:${j}`,
        position: new THREE.Vector3(
          THREE.MathUtils.lerp(a.x, b.x, t),
          THREE.MathUtils.lerp(elevations[i], elevations[i + 1], t) - depth / 2,
          THREE.MathUtils.lerp(a.z, b.z, t),
        ),
        quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, forward)),
        halfExtents: new THREE.Vector3(width / 2, depth * up.y / 2, Math.hypot(horizontal, rise) / steps / 2),
      });
    }
  }
  return result;
}

/** Each rendered railing prism has eight vertices. Reading those keeps every opening,
 * bend and slope identical in physics, without a second placement algorithm. */
export function bridgeRailingColliders(roadId: string, geometry: THREE.BufferGeometry): BridgeCollider[] {
  const positions = geometry.getAttribute('position');
  const result: BridgeCollider[] = [];
  const vertex = (i: number) => new THREE.Vector3().fromBufferAttribute(positions, i);
  for (let i = 0; i < positions.count; i += 8) {
    const a = vertex(i);
    const across = vertex(i + 1).sub(a);
    const up = vertex(i + 3).sub(a);
    const forward = vertex(i + 4).sub(a);
    const halfExtents = new THREE.Vector3(across.length() / 2, up.length() / 2, forward.length() / 2);
    if (Math.min(halfExtents.x, halfExtents.y, halfExtents.z) < 1e-6) continue;
    result.push({
      id: `bridge:${roadId}:rail:${i / 8}`,
      position: a.add(vertex(i + 6)).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(across.normalize(), up.normalize(), forward.normalize().negate()),
      ),
      halfExtents,
    });
  }
  return result;
}
