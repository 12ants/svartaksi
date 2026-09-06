import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bridgeDeckColliders, bridgeRailingColliders } from '../../src/world/bridgeColliders';
import { buildRoadRailingGeometry } from '../../src/world/bridgeRailings';
import { createBridgeLayer } from '../../src/physics/bridgeLayer';
import { createPhysicsWorld } from '../../src/physics/world';
import { resolveCharacterMovement, resolveCharacterCeiling } from '../../src/physics/characterController';
import { CATEGORY_BUILDINGS } from '../../src/physics/types';
import type { WorldRoad } from '../../src/world/types';

const road: WorldRoad = { id: 'span', kind: 'primary', structure: 'bridge', width: 10,
  points: [{ x: -20, z: 0 }, { x: 20, z: 0 }] };

function fixture() {
  const world = createPhysicsWorld();
  const layer = createBridgeLayer(world);
  const railing = buildRoadRailingGeometry(road, road.points, [5, 5], [4.86, 4.86])!;
  const frames = [
    ...bridgeDeckColliders(road.id, road.points, [5, 5], [0.4, 0.4], road.width),
    ...bridgeRailingColliders(road.id, railing),
  ];
  layer.setColliders(frames);
  layer.update(new THREE.Vector3());
  return { world, layer };
}

describe('bridge collision frames', () => {
  it('leaves the underpass empty and makes the slab solid from above and below', () => {
    const { world } = fixture();
    expect(world.raycast(new THREE.Vector3(0, 1, -15), new THREE.Vector3(0, 0, 1), 30)).toBeNull();
    const top = world.raycast(new THREE.Vector3(0, 7, 0), new THREE.Vector3(0, -1, 0), 4)!;
    expect(top.point.y).toBeCloseTo(5);
    const underside = world.raycast(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0), 4)!;
    expect(underside.point.y).toBeCloseTo(4.6);
    expect(underside.normal.y).toBeLessThan(0);
  });

  it('blocks walking through a parapet on the deck but allows walking below it', () => {
    const { world } = fixture();
    const onDeck = resolveCharacterMovement(world, 5, 0, 4.65, 0.42, 0.85, CATEGORY_BUILDINGS, 0, false);
    expect(onDeck.z).toBeLessThan(4.5);
    const below = resolveCharacterMovement(world, 0, 0, 4.65, 0.42, 0.85, CATEGORY_BUILDINGS, 0, false);
    expect(below.z).toBe(4.65);
  });

  it('stops an upward jump at the underside without hoisting the character onto the deck', () => {
    const { world } = fixture();
    expect(resolveCharacterCeiling(world, 0, 0, 2, 4, 1.7)).toBeCloseTo(2.9);
    expect(resolveCharacterCeiling(world, 0, 0, 5, 6, 1.7)).toBe(6);
  });

  it('drops stale frames when streaming replaces a bridge and cleans up on disposal', () => {
    const { world, layer } = fixture();
    expect(world.bodies().length).toBeGreaterThan(0);
    layer.setColliders([]);
    layer.update(new THREE.Vector3());
    expect(world.bodies()).toHaveLength(0);
    layer.dispose();
    expect(world.bodies()).toHaveLength(0);
  });
});
