import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boxInParentSpace, fitToGround, SPAWN_TARGET_SIZE } from '../../src/svartaksi/spawnedModel';

/** A model-shaped stand-in: a box of arbitrary size sitting at an arbitrary offset, which
 * is what an export with its own scale and origin convention looks like from here. */
function fakeModel(width: number, height: number, depth: number, offset = new THREE.Vector3()) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(offset.x, offset.y, offset.z);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const inner = new THREE.Group();
  inner.add(mesh);
  return inner;
}

function measure(object: THREE.Object3D) {
  const box = boxInParentSpace(object);
  return {
    height: box.max.y - box.min.y,
    longest: Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z),
    base: box.min.y,
    box,
  };
}

describe('fitToGround', () => {
  it('scales the longest side to the target and stands the model on its parent origin', () => {
    const parent = new THREE.Group();
    const model = fakeModel(1, 4, 2, new THREE.Vector3(7, 30, -5));
    parent.add(model);

    fitToGround(model, SPAWN_TARGET_SIZE);

    const { longest, base, box } = measure(model);
    expect(longest).toBeCloseTo(SPAWN_TARGET_SIZE, 6);
    expect(base).toBeCloseTo(0, 6);
    // Centred horizontally, so the caller places it by a ground point and nothing else.
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 6);
  });

  it('is idempotent — re-fitting an already-fitted model changes nothing', () => {
    const parent = new THREE.Group();
    const model = fakeModel(2, 5, 3);
    parent.add(model);
    fitToGround(model, SPAWN_TARGET_SIZE);
    const first = measure(model);
    fitToGround(model, SPAWN_TARGET_SIZE);
    const second = measure(model);
    expect(second.longest).toBeCloseTo(first.longest, 6);
    expect(second.base).toBeCloseTo(first.base, 6);
  });

  it('re-fits correctly after a rotation, which is the whole reason it can be re-run', () => {
    // Tipping moves the underside; without a re-fit the model floats or sinks.
    const parent = new THREE.Group();
    const model = fakeModel(2, 1, 6);
    parent.add(model);
    fitToGround(model, SPAWN_TARGET_SIZE);
    expect(measure(model).longest).toBeCloseTo(SPAWN_TARGET_SIZE, 6);

    model.rotation.x = Math.PI / 2;
    fitToGround(model, SPAWN_TARGET_SIZE);
    const tipped = measure(model);
    expect(tipped.longest).toBeCloseTo(SPAWN_TARGET_SIZE, 6);
    expect(tipped.base).toBeCloseTo(0, 6);
  });

  it('holds the invariant through all four quarter turns', () => {
    const parent = new THREE.Group();
    const model = fakeModel(2, 1, 6);
    parent.add(model);
    for (let turn = 0; turn < 4; turn += 1) {
      model.rotation.x = (turn * Math.PI) / 2;
      fitToGround(model, SPAWN_TARGET_SIZE);
      const { longest, base } = measure(model);
      expect(longest, `turn ${turn}`).toBeCloseTo(SPAWN_TARGET_SIZE, 6);
      expect(base, `turn ${turn}`).toBeCloseTo(0, 6);
    }
  });

  it('measures in the parent frame, so a spawn placed out in the world still fits', () => {
    // Box3.setFromObject would give a world box here, and using it would walk the model
    // off across the map on every re-fit.
    const parent = new THREE.Group();
    parent.position.set(400, 12, -900);
    parent.rotation.y = 1.1;
    const model = fakeModel(2, 5, 3);
    parent.add(model);

    fitToGround(model, SPAWN_TARGET_SIZE);

    const { longest, base } = measure(model);
    expect(longest).toBeCloseTo(SPAWN_TARGET_SIZE, 6);
    expect(base).toBeCloseTo(0, 6);
    // The model stays where its parent put it rather than drifting toward the origin.
    const world = new THREE.Box3().setFromObject(model);
    expect((world.min.x + world.max.x) / 2).toBeCloseTo(400, 4);
    expect(world.min.y).toBeCloseTo(12, 4);
  });

  it('leaves a model with no geometry alone rather than producing NaN', () => {
    const parent = new THREE.Group();
    const empty = new THREE.Group();
    parent.add(empty);
    fitToGround(empty, SPAWN_TARGET_SIZE);
    for (const value of [empty.scale.x, empty.position.x, empty.position.y, empty.position.z]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
