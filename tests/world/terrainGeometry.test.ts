import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildParkGeometry } from '../../src/world/terrainGeometry';
import {
  computeTerrainClearance,
  DEFAULT_TERRAIN_SETTINGS,
  terrainHeightAt,
  type TerrainSettings,
} from '../../src/world/terrain';
import type { WorldArea } from '../../src/world/types';

const square = (size: number) => [
  { x: 0, z: 0 }, { x: size, z: 0 }, { x: size, z: size }, { x: 0, z: size },
];

/** A square whose edges carry vertices between the corners — needed to check the bank
 * itself, since a plain quad's every vertex *is* a corner, and corners are the one place
 * the mitre offset and the distance-to-edge metric are not the same measurement. */
const subdividedSquare = (size: number, step: number) => {
  const ring: Array<{ x: number; z: number }> = [];
  for (let d = 0; d < size; d += step) ring.push({ x: d, z: 0 });
  for (let d = 0; d < size; d += step) ring.push({ x: size, z: d });
  for (let d = size; d > 0; d -= step) ring.push({ x: d, z: size });
  for (let d = size; d > 0; d -= step) ring.push({ x: 0, z: d });
  return ring;
};
const wood = (id: string, size = 400): WorldArea => ({ id, kind: 'wood', rings: [square(size)] });
const banked = (id: string, size = 400): WorldArea =>
  ({ id, kind: 'wood', rings: [subdividedSquare(size, 25)] });

function vertices(geometry: THREE.BufferGeometry): Array<{ x: number; y: number; z: number }> {
  const position = geometry.getAttribute('position');
  const out = [];
  for (let index = 0; index < position.count; index += 1) {
    out.push({ x: position.getX(index), y: position.getY(index), z: position.getZ(index) });
  }
  return out;
}

describe('buildParkGeometry', () => {
  it('draws the surface the physics solves against, all the way up the bank', () => {
    // The whole reason this module is separate: the mesh is sampled from the same profile
    // terrainHeightAt uses, so the two cannot disagree. When the bank was a single quad
    // and the profile a smoothstep, the middle of the slope was out by a tenth of the
    // mound's height and a wheel visibly hovered there.
    const area = banked('agreement');
    const geometry = buildParkGeometry(area);
    const terrain = computeTerrainClearance([area]);
    let checked = 0;
    for (const vertex of vertices(geometry)) {
      // Skip the corners, where the mitre offset and the distance-to-edge metric part
      // company by construction; every straight run of edge is the honest test.
      if (Math.min(vertex.x, 400 - vertex.x) < 40 && Math.min(vertex.z, 400 - vertex.z) < 40) continue;
      expect(vertex.y).toBeCloseTo(terrainHeightAt(vertex, terrain), 4);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('keeps agreeing when the height slider is pushed to the top', () => {
    const settings: TerrainSettings = { ...DEFAULT_TERRAIN_SETTINGS, scale: 8 };
    const area = banked('tall');
    const geometry = buildParkGeometry(area, settings);
    const terrain = computeTerrainClearance([area], settings);
    for (const vertex of vertices(geometry)) {
      if (Math.min(vertex.x, 400 - vertex.x) < 80 && Math.min(vertex.z, 400 - vertex.z) < 80) continue;
      expect(Math.abs(vertex.y - terrainHeightAt(vertex, terrain))).toBeLessThan(0.02);
    }
  });

  it('faces the sky, whichever way round the ring is wound', () => {
    for (const ring of [square(200), square(200).reverse()]) {
      const geometry = buildParkGeometry({ id: 'winding', kind: 'wood', rings: [ring] });
      geometry.computeVertexNormals();
      const normals = geometry.getAttribute('normal');
      const position = geometry.getAttribute('position');
      geometry.computeBoundingBox();
      const top = geometry.boundingBox!.max.y;
      let capNormals = 0;
      for (let index = 0; index < normals.count; index += 1) {
        if (position.getY(index) < top - 1e-4) continue;
        expect(normals.getY(index)).toBeGreaterThan(0.5);
        capNormals += 1;
      }
      expect(capNormals).toBeGreaterThan(0);
    }
  });

  it('stands on the ground plane and reaches its mapped height', () => {
    const geometry = buildParkGeometry(wood('extent'));
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(geometry.boundingBox!.max.y).toBeGreaterThan(0.6);
  });

  it('never reaches outside the polygon it was given', () => {
    const geometry = buildParkGeometry(wood('footprint', 200));
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeGreaterThanOrEqual(-1e-6);
    expect(geometry.boundingBox!.max.x).toBeLessThanOrEqual(200 + 1e-6);
  });

  it('is a plain prism again with the slope turned off', () => {
    const geometry = buildParkGeometry(wood('walled'), { ...DEFAULT_TERRAIN_SETTINGS, slope: 0 });
    geometry.computeBoundingBox();
    const top = geometry.boundingBox!.max.y;
    // Nothing in between: every vertex is on the ground or on the flat top.
    for (const vertex of vertices(geometry)) {
      expect(vertex.y < 1e-6 || vertex.y > top - 1e-6).toBe(true);
    }
  });

  it('returns an empty geometry for a degenerate ring rather than throwing', () => {
    expect(buildParkGeometry({ id: 'sliver', kind: 'wood', rings: [[{ x: 0, z: 0 }, { x: 1, z: 0 }]] })
      .getAttribute('position')).toBeUndefined();
  });
});
