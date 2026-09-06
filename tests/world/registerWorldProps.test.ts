import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  busStopProps,
  mailboxProps,
  mappedObjectProps,
  streetLightProps,
  trafficSignalProps,
  treeProps,
  PROP_REGISTRATION_RADIUS,
} from '../../src/world/registerWorldProps';
import type { TreePlacement } from '../../src/world/vegetation';
import type { TrafficSignal } from '../../src/svartaksi/trafficLights';
import type { WorldObject } from '../../src/world/types';

/** Stands in for a built batch: named instanced meshes under one group. */
function batch(parts: Array<{ name: string; count: number }>): THREE.Group {
  const group = new THREE.Group();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      part.count,
    );
    mesh.name = part.name;
    for (let index = 0; index < part.count; index += 1) {
      mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index, 1, 0));
    }
    group.add(mesh);
  }
  return group;
}

describe('streetLightProps', () => {
  it('makes one prop per lamp, gathering every part mesh into it', () => {
    const group = batch([
      { name: 'world:street-lights:poles', count: 3 },
      { name: 'world:street-lights:bulbs', count: 3 },
    ]);
    const lights = [0, 1, 2].map((index) => ({ x: index * 4, z: 0, yaw: 0 }));
    const props = streetLightProps(group, lights, 0, 0);
    expect(props).toHaveLength(3);
    expect(props[0].parts).toHaveLength(2);
    expect(props[0].kind).toBe('street-light');
    // Each prop owns its own instance slot in both meshes.
    expect(props[1].parts.map((part) => part.index)).toEqual([1, 1]);
  });

  it('gives each lamp an id that survives a rebuild of the same world', () => {
    const group = batch([{ name: 'world:street-lights:poles', count: 2 }]);
    const lights = [{ x: 10.5, z: -3.25, yaw: 0 }, { x: 20, z: 0, yaw: 0 }];
    const first = streetLightProps(group, lights, 0, 0).map((prop) => prop.id);
    const second = streetLightProps(group, lights, 0, 0).map((prop) => prop.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
  });

  it('skips lamps beyond the registration radius', () => {
    const group = batch([{ name: 'world:street-lights:poles', count: 2 }]);
    const props = streetLightProps(group, [
      { x: 5, z: 0, yaw: 0 },
      { x: PROP_REGISTRATION_RADIUS + 50, z: 0, yaw: 0 },
    ], 0, 0);
    expect(props).toHaveLength(1);
  });

  it('returns nothing when the batch was never built', () => {
    expect(streetLightProps(new THREE.Group(), [{ x: 0, z: 0, yaw: 0 }], 0, 0)).toHaveLength(0);
  });
});

describe('trafficSignalProps', () => {
  it('makes one prop per head across all five of the batch\'s meshes', () => {
    const group = batch([
      { name: 'world:traffic-lights:poles', count: 2 },
      { name: 'world:traffic-lights:housings', count: 2 },
      { name: 'world:traffic-lights:red', count: 2 },
      { name: 'world:traffic-lights:amber', count: 2 },
      { name: 'world:traffic-lights:green', count: 2 },
    ]);
    const signals: TrafficSignal[] = [
      { x: 0, z: 0, yaw: 0, group: 0, cycle: { offset: 0, period: 40 } } as unknown as TrafficSignal,
      { x: 6, z: 0, yaw: 1, group: 1, cycle: { offset: 0, period: 40 } } as unknown as TrafficSignal,
    ];
    const props = trafficSignalProps(group, signals, 0, 0);
    expect(props).toHaveLength(2);
    expect(props[0].parts).toHaveLength(5);
    expect(props[0].colliders).toHaveLength(2);
  });
});

describe('busStopProps', () => {
  it('claims every slot a shelter owns in a mesh that holds several per stop', () => {
    const group = batch([
      { name: 'world:bus-stops:posts', count: 8 },
      { name: 'world:bus-stops:roof', count: 2 },
    ]);
    const props = busStopProps(group, [
      { x: 0, z: 0, yaw: 0 },
      { x: 30, z: 0, yaw: 0 },
    ], 0, 0);
    expect(props).toHaveLength(2);
    // Four post instances plus one roof for each shelter.
    expect(props[0].parts.map((part) => part.index)).toEqual([0, 1, 2, 3, 0]);
    expect(props[1].parts.map((part) => part.index)).toEqual([4, 5, 6, 7, 1]);
  });
});

describe('mailboxProps', () => {
  it('makes one prop per box', () => {
    const group = batch([
      { name: 'world:mailboxes:post', count: 2 },
      { name: 'world:mailboxes:body', count: 2 },
    ]);
    const props = mailboxProps(group, [{ x: 1, z: 1, yaw: 0.5 }, { x: 2, z: 2, yaw: 0 }], 0, 0);
    expect(props).toHaveLength(2);
    expect(props[0].kind).toBe('mailbox');
    expect(props[0].yaw).toBe(0.5);
  });
});

describe('treeProps', () => {
  const tree = (kind: TreePlacement['kind'], x: number): TreePlacement => ({
    x, z: 0, y: 0, kind, height: 12, radius: 3, yaw: 0, tint: 0.5,
  });

  it('pairs each tree with its own trunk and its own crown', () => {
    const group = batch([
      { name: 'world:trees:needleleaf', count: 2 },
      { name: 'world:trees:broadleaf', count: 1 },
      { name: 'world:trees:trunks', count: 3 },
    ]);
    const trees = [tree('needleleaf', 0), tree('broadleaf', 4), tree('needleleaf', 8)];
    const props = treeProps(group, trees, 0, 0);
    expect(props).toHaveLength(3);
    // Trunks run in placement order; crowns run per leaf type, which is the whole reason
    // trees cannot go through the uniform path the other batches use.
    expect(props[0].parts.map((part) => [part.mesh.name, part.index])).toEqual([
      ['world:trees:trunks', 0], ['world:trees:needleleaf', 0],
    ]);
    expect(props[1].parts.map((part) => [part.mesh.name, part.index])).toEqual([
      ['world:trees:trunks', 1], ['world:trees:broadleaf', 0],
    ]);
    expect(props[2].parts.map((part) => [part.mesh.name, part.index])).toEqual([
      ['world:trees:trunks', 2], ['world:trees:needleleaf', 1],
    ]);
  });

  it('keeps the crown ordering right even when a distant tree is skipped', () => {
    const group = batch([
      { name: 'world:trees:needleleaf', count: 2 },
      { name: 'world:trees:trunks', count: 2 },
    ]);
    const trees = [
      tree('needleleaf', PROP_REGISTRATION_RADIUS + 100),
      tree('needleleaf', 5),
    ];
    const props = treeProps(group, trees, 0, 0);
    expect(props).toHaveLength(1);
    // The skipped tree still occupied crown slot 0, so the kept one is slot 1.
    expect(props[0].parts.map((part) => part.index)).toEqual([1, 1]);
  });

  it('stands the tree on the terrain it was planted in, not at y=0', () => {
    const group = batch([{ name: 'world:trees:trunks', count: 1 }]);
    const props = treeProps(group, [{ ...tree('broadleaf', 0), y: 3.6 }], 0, 0);
    expect(props[0].position.y).toBe(3.6);
  });

  it('sizes the collision frame from the tree\'s own height', () => {
    const group = batch([{ name: 'world:trees:trunks', count: 2 }]);
    const props = treeProps(group, [
      { ...tree('needleleaf', 0), height: 6 },
      { ...tree('needleleaf', 4), height: 18 },
    ], 0, 0);
    const heightOf = (index: number) => {
      const trunk = props[index].colliders[0];
      return trunk.shape.kind === 'box' ? trunk.shape.halfExtents.y : 0;
    };
    expect(heightOf(1)).toBeCloseTo(heightOf(0) * 3, 5);
  });
});

describe('mappedObjectProps', () => {
  const object = (id: string, kind: string, x: number): WorldObject => ({
    id, kind, point: { x, z: 0 }, properties: {},
  });

  it('reads each kind\'s own mesh, matching its filtered instance order', () => {
    const group = batch([
      { name: 'world:objects:bench', count: 2 },
      { name: 'world:objects:flagpole', count: 1 },
    ]);
    const objects = [
      object('b1', 'bench', 0),
      object('f1', 'flagpole', 5),
      object('b2', 'bench', 10),
      object('x', 'fountain', 12),
    ];
    const props = mappedObjectProps(group, objects, 0, 0);
    expect(props.map((prop) => prop.id)).toEqual(['object:b1', 'object:b2', 'object:f1']);
    expect(props[0].kind).toBe('bench');
    expect(props[2].kind).toBe('mast');
  });

  it('registers masonry fountains while leaving bicycle hoops out', () => {
    const group = batch([
      { name: 'world:objects:fountain', count: 1 },
      { name: 'world:objects:bicycle_parking', count: 1 },
    ]);
    expect(mappedObjectProps(group, [
      object('f', 'fountain', 0),
      object('p', 'bicycle_parking', 2),
    ], 0, 0).map((prop) => prop.kind)).toEqual(['fountain']);
  });

  it('groups the kinds that share one mesh', () => {
    const group = batch([{ name: 'world:objects:artwork', count: 3 }]);
    const props = mappedObjectProps(group, [
      object('a', 'artwork', 0),
      object('s', 'statue', 2),
      object('c', 'sculpture', 4),
    ], 0, 0);
    expect(props).toHaveLength(3);
    expect(props.every((prop) => prop.kind === 'small-furniture')).toBe(true);
  });
});

it('keeps all furniture parts together at the terrain height', () => {
  const group = batch([
    { name: 'world:objects:waste_basket', count: 1 },
    { name: 'world:objects:waste_basket:lid', count: 1 },
  ]);
  const props = mappedObjectProps(group, [{ id: 'bin', kind: 'waste_basket', point: { x: 0, z: 0 }, properties: {} }], 0, 0, () => 1.1);
  expect(props[0].position.y).toBe(1.1);
  expect(props[0].parts).toHaveLength(2);
});
