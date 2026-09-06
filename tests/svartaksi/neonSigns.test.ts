import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createNeonSigns, generateNeonSigns } from '../../src/svartaksi/neonSigns';
import type { WorldBuilding, WorldObject } from '../../src/world/types';

/** A square building with its south wall (z = -halfSize) facing the street. */
function block(id: string, x: number, z: number, halfSize = 10, height = 14): WorldBuilding {
  return {
    id,
    height,
    rings: [[
      { x: x - halfSize, z: z - halfSize },
      { x: x + halfSize, z: z - halfSize },
      { x: x + halfSize, z: z + halfSize },
      { x: x - halfSize, z: z + halfSize },
    ]],
    properties: {},
  };
}

const shop = (id: string, x: number, z: number): WorldObject => ({
  id, kind: 'storefront', point: { x, z }, properties: { class: 'shop' },
});

describe('generateNeonSigns', () => {
  it('hangs a sign on the wall nearest the shop, facing away from the building', () => {
    const signs = generateNeonSigns([shop('s1', 0, -14)], [block('b1', 0, 0)], 10);

    expect(signs).toHaveLength(1);
    const [sign] = signs;
    // On the south wall, standing just clear of it.
    expect(sign.z).toBeLessThan(-10);
    expect(sign.z).toBeGreaterThan(-11);
    expect(sign.x).toBeCloseTo(0, 6);
    // Facing out into the street: yaw is the wall's outward normal, which here is -z.
    expect(Math.sin(sign.yaw)).toBeCloseTo(0, 6);
    expect(Math.cos(sign.yaw)).toBeCloseTo(-1, 6);
  });

  it('hangs the sign above the ground-floor shopfront glass but under the roof', () => {
    const [tall] = generateNeonSigns([shop('s1', 0, -14)], [block('b1', 0, 0, 10, 20)], 10);
    // Clear of the storefront's ground-floor window row (firstFloorHeight + windowHeight
    // lands around 5.3m for the `store` facade profile).
    expect(tall.y).toBeGreaterThan(4.8);
    expect(tall.y + tall.height / 2).toBeLessThan(20);

    // On a low building the sign drops rather than punching through the roof.
    const [low] = generateNeonSigns([shop('s2', 0, -14)], [block('b2', 0, 0, 10, 7)], 10);
    expect(low.y + low.height / 2).toBeLessThan(7);
  });

  it('skips a shop with no building in reach, and a building too short to carry a sign', () => {
    expect(generateNeonSigns([shop('far', 0, -400)], [block('b1', 0, 0)], 10)).toHaveLength(0);
    // Too short to clear the ground-floor shopfront window and still leave room under
    // the roof for the sign.
    expect(generateNeonSigns([shop('s1', 0, -14)], [block('hut', 0, 0, 10, 5)], 10)).toHaveLength(0);
    expect(generateNeonSigns([], [block('b1', 0, 0)], 10)).toHaveLength(0);
    expect(generateNeonSigns([shop('s1', 0, -14)], [], 10)).toHaveLength(0);
  });

  it('ignores objects that are not storefronts', () => {
    const bench: WorldObject = { id: 'bench', kind: 'bench', point: { x: 0, z: -14 }, properties: {} };
    expect(generateNeonSigns([bench], [block('b1', 0, 0)], 10)).toHaveLength(0);
  });

  it('gives one building at most one sign', () => {
    const signs = generateNeonSigns(
      [shop('s1', 0, -14), shop('s2', 2, -14), shop('s3', -2, -14)],
      [block('b1', 0, 0)],
      10,
    );
    expect(signs).toHaveLength(1);
  });

  it('is stable across runs and honours its limit', () => {
    const shops = [shop('s1', 0, -14), shop('s2', 100, -14), shop('s3', 200, -14)];
    const buildings = [block('b1', 0, 0), block('b2', 100, 0), block('b3', 200, 0)];

    expect(generateNeonSigns(shops, buildings, 10)).toHaveLength(3);
    expect(generateNeonSigns(shops, buildings, 2)).toHaveLength(2);
    expect(generateNeonSigns(shops, buildings, 0)).toHaveLength(0);
    // Same input, same signs — down to which colour each shop drew.
    expect(generateNeonSigns([...shops].reverse(), buildings, 10))
      .toEqual(generateNeonSigns(shops, buildings, 10));
  });

  it('finds a building it does not share a lookup cell with', () => {
    // A shop node placed just outside a large building whose centroid is far away: the
    // sign has to come from the building's footprint, not from its centre point.
    const wide = block('wide', 0, 0, 60, 16);
    expect(generateNeonSigns([shop('s1', 55, -70)], [wide], 10)).toHaveLength(1);
  });
});

describe('createNeonSigns', () => {
  it('builds an empty, harmless batch when there is nothing to light', () => {
    const batch = createNeonSigns([]);
    expect(batch.group.children).toHaveLength(0);
    expect(() => batch.update(1, 1)).not.toThrow();
  });

  it('draws every sign in one instanced batch and drives it from time and night', () => {
    const signs = generateNeonSigns([shop('s1', 0, -14), shop('s2', 100, -14)], [block('b1', 0, 0), block('b2', 100, 0)], 10);
    const batch = createNeonSigns(signs);

    const faces = batch.group.getObjectByName('world:neon-signs:faces') as THREE.InstancedMesh;
    expect(faces).toBeInstanceOf(THREE.InstancedMesh);
    expect(faces.count).toBe(2);
    // Plate and tube share one quad, so a sign is one draw call and two triangles.
    expect(batch.group.children).toHaveLength(1);
    expect(faces.geometry).toBeInstanceOf(THREE.PlaneGeometry);

    const material = faces.material as THREE.ShaderMaterial;
    batch.update(4.5, 0.8);
    expect(material.uniforms.uTime.value).toBe(4.5);
    expect(material.uniforms.uNight.value).toBe(0.8);
    // fogDensity has to exist on the material or the renderer's per-frame fog refresh
    // throws the moment a scene with fog draws it.
    expect(material.uniforms.fogDensity).toBeDefined();
  });

  it('shades the backing plate down as night comes in', () => {
    const signs = generateNeonSigns([shop('s1', 0, -14)], [block('b1', 0, 0)], 10);
    const batch = createNeonSigns(signs);
    const faces = batch.group.getObjectByName('world:neon-signs:faces') as THREE.InstancedMesh;
    const plateLight = (faces.material as THREE.ShaderMaterial).uniforms.uPlateLight.value as THREE.Color;

    batch.update(0, 0);
    const day = plateLight.r;
    batch.update(0, 1);
    expect(plateLight.r).toBeLessThan(day);
    expect(plateLight.r).toBeGreaterThan(0);
  });

  it('places the instance where the placement says, at the size it asked for', () => {
    const [sign] = generateNeonSigns([shop('s1', 0, -14)], [block('b1', 0, 0)], 10);
    const faces = createNeonSigns([sign]).group.getObjectByName('world:neon-signs:faces') as THREE.InstancedMesh;

    const matrix = new THREE.Matrix4();
    faces.getMatrixAt(0, matrix);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    matrix.decompose(position, new THREE.Quaternion(), scale);

    expect(position.x).toBeCloseTo(sign.x, 5);
    expect(position.y).toBeCloseTo(sign.y, 5);
    expect(position.z).toBeCloseTo(sign.z, 5);
    // The quad carries the backing plate too, so it is scaled out past the tube frame.
    expect(scale.x).toBeGreaterThan(sign.width);
    expect(scale.x).toBeCloseTo(sign.width * (scale.y / sign.height), 5);
  });
});
