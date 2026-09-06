import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPhysicsDebugRenderer, MAX_SEGMENTS } from '../../src/physics/debugRenderer';
import { createPhysicsWorld } from '../../src/physics/world';
import { createBody } from '../../src/physics/rigidBody';
import { createCarVehicle } from '../../src/svartaksi/carPhysics';
import { box, collider, sphere } from '../../src/physics/types';

const origin = new THREE.Vector3();

function drawnSegments(object: THREE.LineSegments): number {
  return object.geometry.drawRange.count / 2;
}

describe('createPhysicsDebugRenderer', () => {
  it('starts hidden and draws nothing until it is switched on', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({ id: 'a', colliders: [collider(box(1, 1, 1))] }));
    const debug = createPhysicsDebugRenderer();
    expect(debug.object.visible).toBe(false);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(0);
    debug.dispose();
  });

  it('draws twelve edges for a box collider', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({ id: 'a', colliders: [collider(box(1, 1, 1))] }));
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(12);
    debug.dispose();
  });

  it('draws a compound body\'s parts separately', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({
      id: 'signal',
      colliders: [collider(box(0.1, 1.8, 0.1)), collider(box(0.2, 0.6, 0.15), new THREE.Vector3(0, 3, 0))],
    }));
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(24);
    debug.dispose();
  });

  it('draws spheres as three rings', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({ id: 'a', colliders: [collider(sphere(0.5))] }));
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(36);
    debug.dispose();
  });

  it('clips to the radius it is given', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({ id: 'near', colliders: [collider(box(1, 1, 1))] }));
    world.addBody(createBody({
      id: 'far',
      colliders: [collider(box(1, 1, 1))],
      position: new THREE.Vector3(600, 0, 0),
    }));
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(12);
    debug.dispose();
  });

  it('adds a suspension ray per wheel for each vehicle', () => {
    const world = createPhysicsWorld();
    const vehicle = createCarVehicle();
    vehicle.chassis.position.set(0, 0.6, 0);
    world.addBody(vehicle.chassis);
    world.addVehicle(vehicle);
    world.step(1 / 60);
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [vehicle], origin, 100);
    // Two box colliders on the chassis (24 edges), one strut line and one contact line per
    // wheel, plus the crosses and normals of whatever contacts the step produced.
    expect(drawnSegments(debug.object)).toBeGreaterThanOrEqual(24 + 8);
    debug.dispose();
  });

  it('rewrites rather than accumulates between frames', () => {
    const world = createPhysicsWorld();
    world.addBody(createBody({ id: 'a', colliders: [collider(box(1, 1, 1))] }));
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 100);
    debug.update(world, [], origin, 100);
    debug.update(world, [], origin, 100);
    expect(drawnSegments(debug.object)).toBe(12);
    debug.dispose();
  });

  it('stops at its line budget instead of overrunning the buffer', () => {
    const world = createPhysicsWorld();
    for (let index = 0; index < 3_000; index += 1) {
      world.addBody(createBody({
        id: `a${index}`,
        colliders: [collider(box(0.2, 0.2, 0.2))],
        position: new THREE.Vector3((index % 50) * 0.5, 0, Math.floor(index / 50) * 0.5),
      }));
    }
    const debug = createPhysicsDebugRenderer();
    debug.setVisible(true);
    debug.update(world, [], origin, 1_000);
    expect(drawnSegments(debug.object)).toBeLessThanOrEqual(MAX_SEGMENTS);
    debug.dispose();
  });

  it('never casts, receives or fights the depth buffer', () => {
    const debug = createPhysicsDebugRenderer();
    const material = debug.object.material as THREE.LineBasicMaterial;
    expect(material.depthTest).toBe(false);
    expect(material.vertexColors).toBe(true);
    expect(debug.object.castShadow).toBe(false);
    expect(debug.object.frustumCulled).toBe(false);
    debug.dispose();
  });
});
