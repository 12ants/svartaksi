import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPropTransform, createPropRegistry } from '../../src/world/propRegistry';
import { box, collider } from '../../src/physics/types';

function instancedMesh(count: number): THREE.InstancedMesh {
  return new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), count);
}

function place(mesh: THREE.InstancedMesh, index: number, position: THREE.Vector3, yaw = 0, scale = 1): void {
  mesh.setMatrixAt(index, new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(scale, scale, scale),
  ));
}

function positionOf(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('createPropRegistry', () => {
  it('measures each part relative to the prop it belongs to', () => {
    const mesh = instancedMesh(1);
    place(mesh, 0, new THREE.Vector3(10, 2.3, -4));
    const registry = createPropRegistry();
    registry.add({
      id: 'post', kind: 'street-light',
      x: 10, y: 0, z: -4, yaw: 0,
      colliders: [collider(box(0.1, 2.3, 0.1))],
      parts: [{ mesh, index: 0 }],
    });
    const [prop] = registry.finalize();
    expect(new THREE.Vector3().setFromMatrixPosition(prop.parts[0].local).y).toBeCloseTo(2.3, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(prop.parts[0].local).x).toBeCloseTo(0, 6);
  });

  it('takes the prop\'s own yaw out of the part placement', () => {
    const mesh = instancedMesh(1);
    // A part one metre "ahead" of a prop that is itself turned a quarter turn.
    place(mesh, 0, new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const registry = createPropRegistry();
    registry.add({
      id: 'p', kind: 'mailbox', x: 0, y: 0, z: 0, yaw: Math.PI / 2,
      colliders: [], parts: [{ mesh, index: 0 }],
    });
    const [prop] = registry.finalize();
    const local = new THREE.Vector3().setFromMatrixPosition(prop.parts[0].local);
    // In the prop's own frame the part sits straight down +z, not out along +x.
    expect(local.z).toBeCloseTo(1, 5);
    expect(local.x).toBeCloseTo(0, 5);
  });

  it('keeps a part\'s scale, which is how the tree crowns are sized', () => {
    const mesh = instancedMesh(1);
    place(mesh, 0, new THREE.Vector3(0, 5, 0), 0, 3);
    const registry = createPropRegistry();
    registry.add({
      id: 'tree', kind: 'tree', x: 0, y: 0, z: 0, yaw: 0, colliders: [], parts: [{ mesh, index: 0 }],
    });
    const [prop] = registry.finalize();
    const scale = new THREE.Vector3().setFromMatrixScale(prop.parts[0].local);
    expect(scale.x).toBeCloseTo(3, 5);
  });
});

describe('applyPropTransform', () => {
  it('carries every part with the prop when it is moved and turned', () => {
    const trunk = instancedMesh(1);
    const crown = instancedMesh(1);
    place(trunk, 0, new THREE.Vector3(4, 0, 0));
    place(crown, 0, new THREE.Vector3(4, 6, 0));
    const registry = createPropRegistry();
    registry.add({
      id: 'tree', kind: 'tree', x: 4, y: 0, z: 0, yaw: 0, colliders: [],
      parts: [{ mesh: trunk, index: 0 }, { mesh: crown, index: 0 }],
    });
    const [prop] = registry.finalize();

    // Laid flat on its side, pointing down +x, ten metres away.
    applyPropTransform(
      prop,
      new THREE.Vector3(20, 0, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2),
    );
    expect(positionOf(trunk, 0).x).toBeCloseTo(20, 5);
    // The crown was six metres up the trunk; laid on its side it is six metres along it.
    expect(positionOf(crown, 0).x).toBeCloseTo(26, 5);
    expect(positionOf(crown, 0).y).toBeCloseTo(0, 5);
  });

  it('marks only the moved instances for upload', () => {
    const mesh = instancedMesh(4);
    for (let index = 0; index < 4; index += 1) place(mesh, index, new THREE.Vector3(index, 0, 0));
    const registry = createPropRegistry();
    registry.add({
      id: 'p', kind: 'mailbox', x: 2, y: 0, z: 0, yaw: 0, colliders: [], parts: [{ mesh, index: 2 }],
    });
    const [prop] = registry.finalize();
    const versionBefore = mesh.instanceMatrix.version;
    applyPropTransform(prop, new THREE.Vector3(2, 0, 9), new THREE.Quaternion());
    expect(mesh.instanceMatrix.version).toBeGreaterThan(versionBefore);
    // The neighbours are untouched — a fallen post box must not disturb the rest of them.
    expect(positionOf(mesh, 1).x).toBeCloseTo(1, 6);
    expect(positionOf(mesh, 2).z).toBeCloseTo(9, 6);
  });
});
