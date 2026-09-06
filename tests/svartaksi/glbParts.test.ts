import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  clusterByGap,
  findMeshesByMaterialName,
  materialNames,
  splitGeometryAlongAxis,
  triangleCentroids,
} from '@/svartaksi/glbParts';

/** Two triangles, each a flat quad-ish sliver centred on `x`. */
function trianglePair(x: number): number[] {
  return [
    x - 0.05, 0, 0, x + 0.05, 0, 0, x, 0.1, 0,
    x - 0.05, 0, 0.1, x + 0.05, 0, 0.1, x, 0.1, 0.1,
  ];
}

function geometryFrom(positions: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

describe('clusterByGap', () => {
  it('splits an axle into one cluster per wheel', () => {
    const clusters = clusterByGap([-0.9, -0.85, -0.8, 0.8, 0.85, 0.9], 0.5);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].center).toBeCloseTo(-0.85);
    expect(clusters[1].center).toBeCloseTo(0.85);
    expect(clusters[0].triangles).toEqual([0, 1, 2]);
    expect(clusters[1].triangles).toEqual([3, 4, 5]);
  });

  it('keeps one cluster when nothing exceeds the gap', () => {
    expect(clusterByGap([0, 0.1, 0.2, 0.3], 0.5)).toHaveLength(1);
  });

  it('is unaffected by the order the centroids arrive in', () => {
    const ordered = clusterByGap([-1, -0.9, 0.9, 1], 0.5);
    const shuffled = clusterByGap([1, -0.9, -1, 0.9], 0.5);

    expect(shuffled.map((cluster) => cluster.center)).toEqual(ordered.map((cluster) => cluster.center));
    // Triangle lists are indices into the input, so they differ — but each cluster still
    // holds the same number of triangles, sorted for a forward walk of the buffer.
    expect(shuffled.map((cluster) => cluster.triangles.length)).toEqual([2, 2]);
    for (const cluster of shuffled) {
      expect([...cluster.triangles].sort((a, b) => a - b)).toEqual(cluster.triangles);
    }
  });

  it('has nothing to say about an empty geometry', () => {
    expect(clusterByGap([], 0.5)).toEqual([]);
  });
});

describe('triangleCentroids', () => {
  it('averages each triangle regardless of whether the geometry is indexed', () => {
    const positions = [0, 0, 0, 3, 0, 0, 0, 3, 0];
    const flat = geometryFrom(positions);
    expect(triangleCentroids(flat, 'x')).toEqual([1]);

    const indexed = geometryFrom(positions);
    indexed.setIndex([0, 1, 2]);
    expect(triangleCentroids(indexed, 'x')).toEqual([1]);
    expect(triangleCentroids(indexed, 'y')).toEqual([1]);
  });
});

describe('splitGeometryAlongAxis', () => {
  it('turns one axle geometry into two wheels, each about its own pivot', () => {
    const geometry = geometryFrom([...trianglePair(-0.85), ...trianglePair(0.85)]);

    const parts = splitGeometryAlongAxis(geometry, 'x', 0.5);

    expect(parts).toHaveLength(2);
    expect(parts[0].pivot.x).toBeCloseTo(-0.85);
    expect(parts[1].pivot.x).toBeCloseTo(0.85);
    // Re-centred: this is what lets the caller spin the wheel about its own axle rather
    // than about the middle of the car.
    for (const part of parts) {
      const center = new THREE.Vector3();
      part.geometry.boundingBox?.getCenter(center);
      expect(center.length()).toBeCloseTo(0, 5);
    }
  });

  it('loses no triangles in the split', () => {
    const geometry = geometryFrom([...trianglePair(-0.85), ...trianglePair(0.85)]);

    const parts = splitGeometryAlongAxis(geometry, 'x', 0.5);
    const total = parts.reduce(
      (sum, part) => sum + part.geometry.getAttribute('position').count / 3,
      0,
    );

    expect(total).toBe(4);
  });

  it('carries every vertex attribute through, not just position', () => {
    const geometry = geometryFrom([...trianglePair(-0.85), ...trianglePair(0.85)]);
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(24), 2));

    const parts = splitGeometryAlongAxis(geometry, 'x', 0.5);

    for (const part of parts) {
      expect(part.geometry.getAttribute('uv').count)
        .toBe(part.geometry.getAttribute('position').count);
    }
  });

  it('re-indexes an indexed source without dropping its triangles', () => {
    const geometry = geometryFrom([...trianglePair(-0.85), ...trianglePair(0.85)]);
    geometry.setIndex([...Array(12).keys()]);

    const parts = splitGeometryAlongAxis(geometry, 'x', 0.5);

    expect(parts).toHaveLength(2);
    expect(parts[0].geometry.getIndex()).toBeNull();
    expect(parts[0].geometry.getAttribute('position').count).toBe(6);
  });
});

describe('finding parts by material', () => {
  it('selects meshes by the name of their material, case-insensitively', () => {
    const root = new THREE.Group();
    const wheel = new THREE.Mesh(geometryFrom(trianglePair(0)), new THREE.MeshStandardMaterial({ name: 'wheel' }));
    const glass = new THREE.Mesh(geometryFrom(trianglePair(1)), new THREE.MeshStandardMaterial({ name: 'glass' }));
    root.add(wheel, glass);

    expect(findMeshesByMaterialName(root, 'WHEEL')).toEqual([wheel]);
    expect(findMeshesByMaterialName(root, 'wheel', 'glass')).toHaveLength(2);
    expect(findMeshesByMaterialName(root, 'chrome')).toEqual([]);
    expect(materialNames(root)).toEqual(['glass', 'wheel']);
  });
});
