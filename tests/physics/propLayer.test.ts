import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPropLayer } from '../../src/physics/propLayer';
import { createPhysicsWorld } from '../../src/physics/world';
import { createBody } from '../../src/physics/rigidBody';
import { smallFurnitureColliders, streetLightColliders } from '../../src/world/propProfiles';
import { box, collider } from '../../src/physics/types';
import type { WorldProp } from '../../src/world/propRegistry';

function instancedMesh(count: number): THREE.InstancedMesh {
  return new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), count);
}

/** One lamp post, with a single rendered part standing at its own mid-height. */
function lampProp(id: string, x: number, z: number): WorldProp {
  const mesh = instancedMesh(1);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 2.3, z));
  return {
    id,
    kind: 'street-light',
    position: new THREE.Vector3(x, 0, z),
    yaw: 0,
    colliders: streetLightColliders(),
    parts: [{ mesh, index: 0, local: new THREE.Matrix4().makeTranslation(0, 2.3, 0) }],
  };
}

function partPosition(prop: WorldProp): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  prop.parts[0].mesh.getMatrixAt(prop.parts[0].index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

/** A car-shaped body aimed down +z at `speed`. */
function striker(z: number, speed: number) {
  const body = createBody({
    id: 'car',
    mass: 1250,
    colliders: [collider(box(1, 0.6, 2), new THREE.Vector3(0, 0.8, 0))],
    position: new THREE.Vector3(0, 0, z),
    neverSleep: true,
  });
  body.linearVelocity.set(0, 0, speed);
  return body;
}

describe('createPropLayer', () => {
  it('only gives bodies to props near the focus point', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world, { activeRadius: 50, maxBodies: 100 });
    layer.setProps([lampProp('near', 10, 0), lampProp('far', 400, 0)]);
    layer.update(new THREE.Vector3(0, 0, 0));
    const ids = world.bodies().map((body) => body.id);
    expect(ids).toContain('prop:near');
    expect(ids).not.toContain('prop:far');
  });

  it('caps how many bodies exist, keeping the nearest', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world, { activeRadius: 500, maxBodies: 2 });
    layer.setProps([
      lampProp('c', 30, 0), lampProp('a', 5, 0), lampProp('d', 90, 0), lampProp('b', 12, 0),
    ]);
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(world.bodies().map((body) => body.id).sort()).toEqual(['prop:a', 'prop:b']);
  });

  it('does not rebuild the set until the focus has actually moved', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world, { activeRadius: 50, refreshDistance: 40 });
    layer.setProps([lampProp('near', 0, 0)]);
    layer.update(new THREE.Vector3(0, 0, 0));
    const first = world.bodies()[0];
    layer.update(new THREE.Vector3(3, 0, 0));
    expect(world.bodies()[0]).toBe(first);
    layer.update(new THREE.Vector3(100, 0, 0));
    expect(world.bodies()).toHaveLength(0);
  });

  it('starts every prop static, so an untouched street costs nothing to simulate', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world);
    layer.setProps([lampProp('a', 0, 0)]);
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(world.bodies()[0].type).toBe('static');
  });

  it('lays the post down in its instanced mesh once it has been knocked over', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world);
    const prop = lampProp('a', 0, 0);
    layer.setProps([prop]);
    layer.update(new THREE.Vector3(0, 0, 0));
    world.addBody(striker(-2.2, 14));

    const dt = 1 / 60;
    for (let step = 0; step < 150; step += 1) {
      world.step(dt);
      layer.sync();
    }
    expect(layer.dislodgedCount()).toBe(1);
    // The rendered part was 2.3m up the standing post; on the ground it is barely up at all.
    expect(partPosition(prop).y).toBeLessThan(1.6);
  });

  it('remembers a felled post across a world rebuild', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world);
    layer.setProps([lampProp('a', 0, 0)]);
    layer.update(new THREE.Vector3(0, 0, 0));
    world.addBody(striker(-2.2, 14));
    for (let step = 0; step < 150; step += 1) {
      world.step(1 / 60);
      layer.sync();
    }

    // A new snapshot: fresh props, fresh meshes, everything standing up again.
    const rebuilt = lampProp('a', 0, 0);
    layer.setProps([rebuilt]);
    layer.update(new THREE.Vector3(0, 0, 0));
    const body = world.bodies().find((candidate) => candidate.id === 'prop:a');
    expect(body?.type).toBe('dynamic');
    expect(partPosition(rebuilt).y).toBeLessThan(1.6);
  });

  it('drops every body it owns when disposed', () => {
    const world = createPhysicsWorld();
    const layer = createPropLayer(world);
    layer.setProps([lampProp('a', 0, 0), lampProp('b', 4, 0)]);
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(world.bodies().length).toBe(2);
    layer.dispose();
    expect(world.bodies()).toHaveLength(0);
  });
});

it('a fountain stops an ordinary car impact without becoming dynamic', () => {
  const world = createPhysicsWorld();
  const layer = createPropLayer(world);
  const fountain = { ...lampProp('fountain', 0, 0), kind: 'fountain' as const, colliders: smallFurnitureColliders(1.25, 0.58) };
  layer.setProps([fountain]);
  layer.update(new THREE.Vector3());
  const car = striker(-3.4, 8);
  world.addBody(car);
  for (let step = 0; step < 90; step += 1) world.step(1 / 60);
  expect(world.bodies().find((body) => body.id === 'prop:fountain')?.type).toBe('static');
  expect(layer.dislodgedCount()).toBe(0);
  expect(car.position.z).toBeLessThan(0);
});
