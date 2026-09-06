import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getGrassNormalMap } from '../../src/svartaksi/grassTexture';

describe('getGrassNormalMap', () => {
  it('builds a square, tiling RGBA normal map texture', () => {
    const texture = getGrassNormalMap();
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(texture.image.height);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    // Repeats are per *world unit*, not per polygon: landuse UVs come straight from an
    // ExtrudeGeometry shape measured in meters. A value above 1 would mean more than one
    // tile per meter, which is sub-pixel at any driving distance.
    expect(texture.repeat.x).toBeLessThan(1);
    expect(texture.repeat.x).toBe(texture.repeat.y);
  });

  it('mip-filters, so a lawn receding to the horizon has something to fall back on', () => {
    const texture = getGrassNormalMap();
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });

  it('returns the same shared instance on repeated calls', () => {
    expect(getGrassNormalMap()).toBe(getGrassNormalMap());
  });

  it('encodes plausible tangent-space normals (mostly-upward, unit length, alpha opaque)', () => {
    const texture = getGrassNormalMap();
    const data = texture.image.data as Uint8Array;
    const size = texture.image.width;
    let sampled = 0;
    for (let index = 0; index < size * size; index += 37) {
      const offset = index * 4;
      const nx = data[offset] / 255 * 2 - 1;
      const ny = data[offset + 1] / 255 * 2 - 1;
      const nz = data[offset + 2] / 255 * 2 - 1;
      const alpha = data[offset + 3];
      const length = Math.hypot(nx, ny, nz);
      expect(length).toBeGreaterThan(0.9);
      expect(length).toBeLessThan(1.1);
      // Bumps are gentle relative to the surface, so Z (out of the surface) should
      // dominate every sample — never a fully sideways-facing normal.
      expect(nz).toBeGreaterThan(0.5);
      expect(alpha).toBe(255);
      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(50);
  });
});
