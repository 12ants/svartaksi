import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildingColliderDescriptor, buildingColliderBodies } from '../../src/world/buildingColliders';
import type { WorldBuilding } from '../../src/world/types';

describe('buildingColliderBodies orientation', () => {
  it('rotates the collider box the same way facades are drawn: local x maps to (cos yaw, sin yaw)', () => {
    // A rectangle whose long edge runs diagonally (neither axis-aligned), so a sign error
    // in the yaw-to-quaternion conversion shows up as a real rotation, not a no-op.
    const building: WorldBuilding = {
      id: 'diag',
      height: 6,
      rings: [[
        { x: 0, z: 0 },
        { x: 10, z: 10 },
        { x: 8, z: 12 },
        { x: -2, z: 2 },
      ]],
    } as WorldBuilding;

    const descriptor = buildingColliderDescriptor(building, []);
    expect(descriptor?.kind).toBe('box');
    const spec = descriptor!.boxes[0];

    const [body] = buildingColliderBodies(descriptor!, 1, 1);
    const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(body.quaternion);

    expect(localX.x).toBeCloseTo(Math.cos(spec.yaw), 5);
    expect(localX.z).toBeCloseTo(Math.sin(spec.yaw), 5);
  });
});
