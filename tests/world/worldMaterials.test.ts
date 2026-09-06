import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createShorelineFoamMaterial,
  createWaterMaterial,
  landuseMaterialOptions,
  setWaterAnimationTime,
  setWorldTextureAnisotropy,
} from '../../src/world/worldMaterials';

/** Runs a material's onBeforeCompile against a stand-in for the shader three would hand
 * it, and returns what came back out. The GLSL itself needs a GPU to verify; what can be
 * checked here is that the hooks it edits are actually present and actually edited. */
function compiled(material: THREE.Material, vertexShader: string, fragmentShader: string) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader, fragmentShader };
  material.onBeforeCompile(shader as never, null as never);
  return shader;
}

const STANDARD_VERTEX = [
  'void main() {',
  '#include <begin_vertex>',
  '#include <project_vertex>',
  '#include <logdepthbuf_vertex>',
  '}',
].join('\n');

const STANDARD_FRAGMENT = [
  'void main() {',
  '#include <color_fragment>',
  '#include <normal_fragment_maps>',
  '}',
].join('\n');

describe('world materials', () => {
  it('creates stable translucent water with cinematic normal detail', () => {
    const material = createWaterMaterial(true);
    expect(material.depthWrite).toBe(false);
    expect(material.polygonOffset).toBe(true);
    expect(material.normalMap).not.toBeNull();
    material.dispose();
  });

  it('uses grass normals only for grass-like landuse', () => {
    expect(landuseMaterialOptions('pitch').normalMap).not.toBeNull();
    expect(landuseMaterialOptions('commercial').normalMap).toBeNull();
  });

  it('tiles water waves per world unit and mip-filters them', () => {
    // Water surfaces are a ShapeGeometry whose UVs are the shape's own coordinates in
    // meters, so a repeat above 1 means more than one wave per meter.
    const material = createWaterMaterial(true);
    const normalMap = material.normalMap as THREE.Texture;
    expect(normalMap.repeat.x).toBeLessThan(1);
    expect(normalMap.generateMipmaps).toBe(true);
    expect(normalMap.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    material.dispose();
  });

  it('animates water from a clock the caller writes, not from an accumulator', () => {
    const material = createWaterMaterial(true);
    const shader = compiled(material, STANDARD_VERTEX, STANDARD_FRAGMENT);
    expect(shader.uniforms.uWaterTime.value).toBe(0);
    setWaterAnimationTime(material, 12.5);
    expect(shader.uniforms.uWaterTime.value).toBe(12.5);
    // A monotonic clock, so replaying an earlier time shows exactly what it showed then —
    // the same property the traffic signals are built on.
    setWaterAnimationTime(material, 3);
    expect(shader.uniforms.uWaterTime.value).toBe(3);
    material.dispose();
  });

  it('scrolls two normal layers and tints water by view angle, and keeps the depth bias', () => {
    const material = createWaterMaterial(true);
    const shader = compiled(material, STANDARD_VERTEX, STANDARD_FRAGMENT);
    // Two taps, not one: a single scrolling layer reads as a sheet sliding sideways.
    expect(shader.fragmentShader.match(/texture2D\( normalMap/g)?.length).toBe(2);
    expect(shader.fragmentShader).toContain('uWaterSky');
    expect(shader.fragmentShader).not.toContain('#include <normal_fragment_maps>');
    // The log-depth bias is what actually separates the sheet from the ground under it;
    // polygonOffset is inert in this scene (see depthBias.ts), so losing this is the bug.
    expect(shader.vertexShader).toContain('vFragDepth *=');
    material.dispose();
  });

  it('gives water its own program cache key, so the bias and the waves are not shared away', () => {
    const water = createWaterMaterial(true);
    const foam = createShorelineFoamMaterial();
    expect(water.customProgramCacheKey!()).not.toBe(new THREE.MeshStandardMaterial().customProgramCacheKey!());
    expect(foam.customProgramCacheKey!()).not.toBe(water.customProgramCacheKey!());
    water.dispose();
    foam.dispose();
  });

  it('washes the shoreline foam along the shore instead of ringing it with a constant band', () => {
    const material = createShorelineFoamMaterial();
    expect(material.vertexColors).toBe(true);
    expect(material.depthWrite).toBe(false);
    const shader = compiled(material, STANDARD_VERTEX, STANDARD_FRAGMENT);
    expect(shader.fragmentShader).toContain('diffuseColor.a *=');
    setWaterAnimationTime(material, 4);
    expect(shader.uniforms.uWaterTime.value).toBe(4);
    material.dispose();
  });

  it('leaves a material it did not make alone', () => {
    const plain = new THREE.MeshBasicMaterial();
    expect(() => setWaterAnimationTime(plain, 5)).not.toThrow();
    plain.dispose();
  });

  it('pushes the renderer anisotropy limit onto both shared detail maps', () => {
    setWorldTextureAnisotropy(8);
    const water = createWaterMaterial(true);
    expect((water.normalMap as THREE.Texture).anisotropy).toBe(8);
    expect((landuseMaterialOptions('park').normalMap as THREE.Texture).anisotropy).toBe(8);
    water.dispose();
  });
});
