import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  DEPTH_BIAS,
  applyLogDepthBias,
  logDepthBiasChunk,
  withLogDepthBias,
} from '../../src/world/depthBias';

describe('log depth bias', () => {
  it('scales vFragDepth under the same guard three.js writes gl_FragDepth behind', () => {
    const chunk = logDepthBiasChunk(DEPTH_BIAS.surface);
    expect(chunk).toContain('#include <logdepthbuf_vertex>');
    expect(chunk).toContain('#ifdef USE_LOGARITHMIC_DEPTH_BUFFER');
    expect(chunk).toContain('vFragDepth *=');
    // A build with the log buffer switched off has to compile this away entirely and
    // fall back to the material's own polygonOffset, which is why the guard is there.
    expect(chunk.indexOf('#ifdef')).toBeLessThan(chunk.indexOf('vFragDepth *='));
  });

  it('pulls a positive bias toward the camera and pushes a negative one back', () => {
    const factor = (bias: number) => Number(/vFragDepth \*= ([\d.]+)/.exec(logDepthBiasChunk(bias))![1]);
    // Stored depth is a logarithm of vFragDepth, so shrinking it moves the surface
    // nearer, which is what wins the depth test.
    expect(factor(DEPTH_BIAS.surface)).toBeLessThan(1);
    expect(factor(DEPTH_BIAS.behind)).toBeGreaterThan(1);
    expect(factor(0)).toBe(1);
  });

  it('rewrites a shader of ours in place, and refuses one with no depth to bias', () => {
    const source = 'void main() {\n  #include <logdepthbuf_vertex>\n}';
    const biased = withLogDepthBias(source, DEPTH_BIAS.decal);
    expect(biased).toContain('vFragDepth *=');
    expect(biased).toContain('void main()');

    expect(() => withLogDepthBias('void main() {}', DEPTH_BIAS.decal)).toThrow(/logdepthbuf_vertex/);
  });

  it('gives a patched built-in material its own program cache key', () => {
    // Two MeshStandardMaterials differing only in what onBeforeCompile did would
    // otherwise share one compiled program, and the first to compile would silently
    // decide the bias for both.
    const front = applyLogDepthBias(new THREE.MeshStandardMaterial(), DEPTH_BIAS.decal);
    const back = applyLogDepthBias(new THREE.MeshStandardMaterial(), DEPTH_BIAS.behind);
    expect(front.customProgramCacheKey()).not.toBe(back.customProgramCacheKey());

    const shader = { vertexShader: '#include <logdepthbuf_vertex>' } as THREE.WebGLProgramParametersWithUniforms;
    front.onBeforeCompile(shader, null as never);
    expect(shader.vertexShader).toContain('vFragDepth *=');
  });

  it('keeps every bias small enough to separate without visibly floating', () => {
    // Roughly: one 24-bit depth unit is 6e-8 and the stored depth moves by 0.128 * bias,
    // so these are tens to hundreds of units apart — far above numerical noise, far
    // below anything that would read as a gap.
    for (const bias of Object.values(DEPTH_BIAS)) {
      expect(Math.abs(bias)).toBeGreaterThan(1e-6);
      expect(Math.abs(bias)).toBeLessThan(1e-3);
    }
    // Surfaces stacked on terrain need more separation than a wall against its own roof.
    expect(DEPTH_BIAS.surface).toBeGreaterThan(DEPTH_BIAS.facade);
    expect(DEPTH_BIAS.behind).toBeLessThan(0);
  });
});
