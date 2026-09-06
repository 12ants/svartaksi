import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { highlightGeometryForIntersection, recordForIntersection } from '../../src/svartaksi/worldInspector';
import { INSPECTION_USER_DATA_KEY, type WorldInspectionRecord } from '../../src/world/inspection';

const records: WorldInspectionRecord[] = [
  { id: 'road:a', category: 'road', title: 'Road A', source: 'maplibre', properties: {} },
  { id: 'road:b', category: 'road', title: 'Road B', source: 'maplibre', properties: {} },
];

/** A stand-in for threeWorld.ts's merged per-style-key road mesh: two roads, two
 * triangles (one quad) each, sharing one buffer, with one inspection record per face —
 * road A's faces both point at the same `perFaceRecords[0]` object, road B's at
 * `perFaceRecords[1]`, exactly as the real merge builds it. */
function mergedRoadMesh(): { mesh: THREE.Mesh; perFaceRecords: WorldInspectionRecord[] } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const perFaceRecords = records;
  mesh.userData[INSPECTION_USER_DATA_KEY] = [
    perFaceRecords[0], perFaceRecords[0], perFaceRecords[1], perFaceRecords[1],
  ];
  return { mesh, perFaceRecords };
}

describe('recordForIntersection', () => {
  it('resolves ordinary and instanced inspection records', () => {
    const ordinary = new THREE.Mesh();
    ordinary.userData[INSPECTION_USER_DATA_KEY] = records[0];
    expect(recordForIntersection({ object: ordinary } as THREE.Intersection)).toBe(records[0]);

    const instanced = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    instanced.userData[INSPECTION_USER_DATA_KEY] = records;
    expect(recordForIntersection({ object: instanced, instanceId: 1 } as THREE.Intersection)).toBe(records[1]);
  });

  it('rejects missing, stale, and out-of-range instance metadata', () => {
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    mesh.userData[INSPECTION_USER_DATA_KEY] = records;
    expect(recordForIntersection({ object: mesh } as THREE.Intersection)).toBeNull();
    expect(recordForIntersection({ object: mesh, instanceId: 9 } as THREE.Intersection)).toBeNull();
    expect(recordForIntersection({ object: new THREE.Mesh() } as THREE.Intersection)).toBeNull();
  });

  it('falls back to the hit face for a merged, non-instanced mesh', () => {
    const { mesh, perFaceRecords } = mergedRoadMesh();
    expect(recordForIntersection({ object: mesh, faceIndex: 0 } as THREE.Intersection)).toBe(perFaceRecords[0]);
    expect(recordForIntersection({ object: mesh, faceIndex: 2 } as THREE.Intersection)).toBe(perFaceRecords[1]);
    expect(recordForIntersection({ object: mesh } as THREE.Intersection)).toBeNull();
  });
});

describe('highlightGeometryForIntersection', () => {
  it('returns the object geometry unchanged for a single-record hit', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());
    mesh.userData[INSPECTION_USER_DATA_KEY] = records[0];
    expect(highlightGeometryForIntersection({ object: mesh } as THREE.Intersection)).toBe(mesh.geometry);
  });

  it('returns the template geometry unchanged for an instanced hit', () => {
    const instanced = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2);
    instanced.userData[INSPECTION_USER_DATA_KEY] = records;
    const result = highlightGeometryForIntersection({ object: instanced, instanceId: 1, faceIndex: 0 } as THREE.Intersection);
    expect(result).toBe(instanced.geometry);
  });

  it('narrows a merged mesh hit to just the hit road, without touching the source drawRange', () => {
    const { mesh } = mergedRoadMesh();
    const result = highlightGeometryForIntersection({ object: mesh, faceIndex: 2 } as THREE.Intersection);
    expect(result).not.toBe(mesh.geometry);
    expect(result.index).toBe(mesh.geometry.index);
    // Road B occupies faces 2-3 -> indices [6, 12).
    expect(result.drawRange).toEqual({ start: 6, count: 6 });
    // The source mesh still draws its full geometry — only the highlight helper's copy
    // was narrowed.
    expect(mesh.geometry.drawRange).toEqual({ start: 0, count: Infinity });
  });
});
