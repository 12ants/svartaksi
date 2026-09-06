import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBuildingLayer } from '../../src/physics/buildingLayer';
import { createPhysicsWorld } from '../../src/physics/world';
import { createBody } from '../../src/physics/rigidBody';
import type { WorldBuilding } from '../../src/world/types';
import type { TerrainClearance } from '../../src/world/terrain';
import { box, CATEGORY_ALL, CATEGORY_BUILDINGS, collider } from '../../src/physics/types';

function rectBuilding(id: string, x: number, z: number, w = 6, d = 4, height = 8): WorldBuilding {
  return {
    id,
    height,
    rings: [[
      { x: x - w / 2, z: z - d / 2 },
      { x: x + w / 2, z: z - d / 2 },
      { x: x + w / 2, z: z + d / 2 },
      { x: x - w / 2, z: z + d / 2 },
    ]],
    properties: {},
  };
}

/** An L-shaped footprint: a bad fit for a single oriented box. */
function lBuilding(id: string, x: number, z: number, height = 8): WorldBuilding {
  return {
    id,
    height,
    rings: [[
      { x: x, z: z },
      { x: x + 10, z: z },
      { x: x + 10, z: z + 4 },
      { x: x + 4, z: z + 4 },
      { x: x + 4, z: z + 10 },
      { x: x, z: z + 10 },
    ]],
    properties: {},
  };
}

const flatTerrain: TerrainClearance[] = [];

describe('createBuildingLayer', () => {
  it('gives a collider only to buildings near the focus point', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    layer.setWorld([rectBuilding('near', 10, 0), rectBuilding('far', 400, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const ids = world.bodies().map((body) => body.id);
    expect(ids.some((id) => id.startsWith('building:near:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('building:far:'))).toBe(false);
  });

  it('does not rebuild the active set until the focus has moved far enough', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50, refreshDistance: 40 });
    layer.setWorld([rectBuilding('a', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const before = world.bodies().length;
    layer.update(new THREE.Vector3(3, 0, 0));
    expect(world.bodies().length).toBe(before);
  });

  it('applies hysteresis: a building at the boundary does not flap in and out', () => {
    const world = createPhysicsWorld();
    // activeRadius 50, releaseMargin 20 -> release at 70.
    const layer = createBuildingLayer(world, { activeRadius: 50, releaseMargin: 20, refreshDistance: 1 });
    layer.setWorld([rectBuilding('edge', 55, 0)], flatTerrain);
    // Outside activeRadius (55 > 50): stays inactive.
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(layer.activeBuildingCount()).toBe(0);

    // Move the focus to put the building at distance 45 (inside activeRadius): activates.
    layer.update(new THREE.Vector3(10, 0, 0));
    expect(layer.activeBuildingCount()).toBe(1);

    // Move the focus so the building is at distance 60 — past activeRadius but still
    // inside releaseRadius (70): must stay active, not flap.
    layer.update(new THREE.Vector3(-5, 0, 0));
    expect(layer.activeBuildingCount()).toBe(1);

    // Move far enough that the building is past releaseRadius: now it releases.
    layer.update(new THREE.Vector3(-30, 0, 0));
    expect(layer.activeBuildingCount()).toBe(0);
  });

  it('reuses descriptors rather than recomputing them across activation cycles', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50, refreshDistance: 1 });
    layer.setWorld([rectBuilding('a', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const firstBody = world.bodies().find((body) => body.id.startsWith('building:a:'));
    expect(firstBody).toBeDefined();
    const firstPosition = firstBody!.position.clone();

    // Cycle out and back in; the recomputed descriptor must produce the identical box.
    layer.update(new THREE.Vector3(1000, 0, 0));
    expect(layer.activeBuildingCount()).toBe(0);
    layer.update(new THREE.Vector3(0, 0, 0));
    const secondBody = world.bodies().find((body) => body.id.startsWith('building:a:'));
    expect(secondBody).toBeDefined();
    expect(secondBody!.position.distanceTo(firstPosition)).toBeLessThan(1e-9);
  });

  it('does not create duplicate bodies for tile-seam copies sharing a building id', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    // Two entries with the same id, as a building straddling a tile seam would arrive.
    layer.setWorld([rectBuilding('dup', 0, 0), rectBuilding('dup', 0.001, 0.001)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const dupBodies = world.bodies().filter((body) => body.id.startsWith('building:dup:'));
    expect(dupBodies).toHaveLength(1);
  });

  it('drops stale colliders when a rebuilt world no longer contains that building', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    layer.setWorld([rectBuilding('gone', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(layer.activeBuildingCount()).toBe(1);

    layer.setWorld([rectBuilding('stays', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const ids = world.bodies().map((body) => body.id);
    expect(ids.some((id) => id.startsWith('building:gone:'))).toBe(false);
    expect(ids.some((id) => id.startsWith('building:stays:'))).toBe(true);
  });

  it('falls back to perimeter wall segments for a concave (L-shaped) footprint', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    layer.setWorld([lBuilding('L', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(5, 0, 5));
    const bodies = world.bodies().filter((body) => body.id.startsWith('building:L:'));
    // Six ring edges -> six thin wall segments, not one box.
    expect(bodies.length).toBe(6);
  });

  it('tags bodies with the building collision category and mask', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    layer.setWorld([rectBuilding('a', 0, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    const body = world.bodies().find((candidate) => candidate.id.startsWith('building:a:'));
    expect(body?.userData.category).toBe(CATEGORY_BUILDINGS);
    expect(body?.userData.mask).toBe(CATEGORY_ALL);
  });

  it('drops every body it owns when disposed', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 50 });
    layer.setWorld([rectBuilding('a', 0, 0), rectBuilding('b', 4, 0)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));
    expect(world.bodies().length).toBeGreaterThan(0);
    layer.dispose();
    expect(world.bodies()).toHaveLength(0);
  });

  it('stops a car-shaped body from tunnelling through a building wall over many steps', () => {
    const world = createPhysicsWorld();
    const layer = createBuildingLayer(world, { activeRadius: 200 });
    // A building centred at z=20, 4m deep, so its near wall sits at about z=18.
    layer.setWorld([rectBuilding('wall', 0, 20, 10, 4, 6)], flatTerrain);
    layer.update(new THREE.Vector3(0, 0, 0));

    const chassis = createBody({
      id: 'car',
      mass: 1250,
      colliders: [collider(box(1, 0.5, 2))],
      position: new THREE.Vector3(0, 3, 0),
      neverSleep: true,
    });
    chassis.linearVelocity.set(0, 0, 20);
    world.addBody(chassis);

    for (let step = 0; step < 240; step += 1) world.step(1 / 60);

    // The wall's near face is at z=18; the car's own half-depth (2m) means its centre
    // should be stopped at or before that face, never past the building's centre at z=20.
    expect(chassis.position.z).toBeLessThan(20);
  });
});
