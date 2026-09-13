import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  isAxleGeometry,
  mergePanels,
  orderWheels,
  orientToCarSpace,
  SAAB_DIMENSIONS,
  SAAB_HALF_WHEELBASE,
} from '@/svartaksi/saabModel';
import { CAR_HALF_TRACK, CAR_HALF_WHEELBASE, CAR_WHEEL_RADIUS } from '@/svartaksi/carModel';

function box(width: number, height: number, depth: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, height, depth);
}

describe('orientToCarSpace', () => {
  it('stands the Z-up asset upright with its wheels on the road', () => {
    const matrix = orientToCarSpace();
    // The asset's lowest point is at z = -groundOffset in its own frame.
    const lowest = new THREE.Vector3(0, 0, -SAAB_DIMENSIONS.groundOffset).applyMatrix4(matrix);

    expect(lowest.y).toBeCloseTo(0, 5);
  });

  it('turns the front of the car to face +Z, where every other body in the game faces', () => {
    const matrix = orientToCarSpace();
    // The front axle is at +y in the asset's frame; forward in this game is +z.
    const front = new THREE.Vector3(0, SAAB_DIMENSIONS.frontAxleZ, 0).applyMatrix4(matrix);

    expect(front.z).toBeCloseTo(SAAB_DIMENSIONS.frontAxleZ, 5);
    expect(front.x).toBeCloseTo(0, 5);
  });

  it('puts the axles at the heights and offsets the physics car is built to', () => {
    const matrix = orientToCarSpace();
    const wheelCentreInAsset = new THREE.Vector3(
      0.86,
      SAAB_DIMENSIONS.frontAxleZ,
      SAAB_DIMENSIONS.wheelRadius - SAAB_DIMENSIONS.groundOffset,
    );

    const wheel = wheelCentreInAsset.applyMatrix4(matrix);

    expect(wheel.y).toBeCloseTo(SAAB_DIMENSIONS.wheelRadius, 5);
    expect(wheel.z).toBeCloseTo(SAAB_DIMENSIONS.frontAxleZ, 5);
  });
});

describe('the car the physics is built to', () => {
  it('is the car in the asset', () => {
    expect(CAR_WHEEL_RADIUS).toBe(SAAB_DIMENSIONS.wheelRadius);
    expect(CAR_HALF_TRACK).toBe(SAAB_DIMENSIONS.halfTrack);
    expect(CAR_HALF_WHEELBASE).toBe(SAAB_HALF_WHEELBASE);
    expect(SAAB_HALF_WHEELBASE).toBeCloseTo(1.33, 5);
  });
});

describe('orderWheels', () => {
  it('sorts the four split parts into front-left, front-right, rear-left, rear-right', () => {
    const part = (x: number, z: number) => ({
      geometry: new THREE.BufferGeometry(),
      pivot: new THREE.Vector3(x, CAR_WHEEL_RADIUS, z),
    });
    const scrambled = [
      part(0.86, -1.26),
      part(-0.86, 1.4),
      part(0.86, 1.4),
      part(-0.86, -1.26),
    ];

    const ordered = orderWheels(scrambled);

    expect(ordered.map((wheel) => [wheel.pivot.x, wheel.pivot.z])).toEqual([
      [-0.86, 1.4],
      [0.86, 1.4],
      [-0.86, -1.26],
      [0.86, -1.26],
    ]);
  });

  it('refuses a car that did not come apart into four wheels, rather than guessing', () => {
    expect(() => orderWheels([])).toThrow(/4 wheels/);
  });
});

/**
 * Every mesh of `saab90.glb`, with its size in car space.
 *
 * These are measurements, not examples: each is the accessor bounds of one node, carried
 * through that node's own transform and then `orientToCarSpace`. The earlier version of
 * this suite invented its panels instead — and invented a *tall* one, which the old test
 * caught — while the asset's real trim strips are thin, which it did not. The whole file
 * then passed against a car that never loaded. Re-measure with the glTF accessor bounds if
 * the asset is re-exported.
 */
const SAAB_MESHES: readonly { name: string; size: readonly [number, number, number]; axle: boolean }[] = [
  { name: 'Box012 — body', size: [1.977, 1.310, 4.906], axle: false },
  { name: 'Cylinder007 — rear axle', size: [1.942, 0.718, 0.718], axle: true },
  { name: 'Box014 — window surround', size: [1.950, 0.146, 0.123], axle: false },
  { name: 'Box015 — front blade', size: [0.583, 0.136, 0.014], axle: false },
  { name: 'Box016 — rear blade', size: [1.367, 0.117, 0.293], axle: false },
  { name: 'Box017 — rear sill', size: [0.583, 0.136, 0.014], axle: false },
  { name: 'Cylinder008 — front axle', size: [1.942, 0.718, 0.718], axle: true },
];

describe('isAxleGeometry', () => {
  for (const mesh of SAAB_MESHES) {
    it(`${mesh.axle ? 'finds the axle in' : 'leaves the body alone for'} ${mesh.name}`, () => {
      expect(isAxleGeometry(box(...mesh.size))).toBe(mesh.axle);
    });
  }

  /* The failure this whole rule exists to prevent. Anything but two axles means five or
   * more wheel parts, orderWheels throws, and the session drives the stand-in box. */
  it('finds exactly two axles in the asset, since four wheels have to come out of them', () => {
    const axles = SAAB_MESHES.filter((mesh) => isAxleGeometry(box(...mesh.size)));
    expect(axles.map((mesh) => mesh.name)).toEqual([
      'Cylinder007 — rear axle',
      'Cylinder008 — front axle',
    ]);
  });

  it('does not mistake a body panel for one', () => {
    expect(isAxleGeometry(box(1.98, 1.31, 4.91))).toBe(false);
    // A roof bar: wide and shallow like an axle, but far too high up to be one.
    expect(isAxleGeometry(box(1.95, 1.2, 0.15))).toBe(false);
  });
});

describe('mergePanels', () => {
  it('collapses panels that share a material into one mesh', () => {
    const material = new THREE.MeshStandardMaterial();
    const meshes = [
      new THREE.Mesh(box(1, 1, 1), material),
      new THREE.Mesh(box(1, 1, 1), material),
      new THREE.Mesh(box(1, 1, 1), material),
    ];

    const merged = mergePanels(meshes);

    expect(merged).toHaveLength(1);
    expect(merged[0].geometry.getAttribute('position').count)
      .toBe(meshes.reduce((sum, mesh) => sum + mesh.geometry.getAttribute('position').count, 0));
  });

  it('keeps materials apart, since a merge cannot span two of them', () => {
    const merged = mergePanels([
      new THREE.Mesh(box(1, 1, 1), new THREE.MeshStandardMaterial()),
      new THREE.Mesh(box(1, 1, 1), new THREE.MeshStandardMaterial()),
    ]);

    expect(merged).toHaveLength(2);
  });
});
