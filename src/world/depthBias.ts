/**
 * Depth bias that survives the logarithmic depth buffer.
 *
 * The scene runs with `logarithmicDepthBuffer: true` (see the Canvas in svartaksiRuntime),
 * which is what keeps ground, landuse and roads apart at a kilometre with a 0.1m near
 * plane. The catch is that three.js implements it by having *every* fragment shader write
 * `gl_FragDepth`:
 *
 *     gl_FragDepth = log2( vFragDepth ) * logDepthBufFC * 0.5;
 *
 * A shader-written depth replaces the one rasterisation produced — and polygon offset is
 * applied during rasterisation. So `polygonOffset` on any material in this scene does
 * exactly nothing, silently. Every place in this codebase that reached for it to separate
 * two near-coplanar layers (road surfaces, water sheets, the fallback building box, the
 * bus's scruff patches, the inspection highlight) has been getting no separation at all,
 * which is the z-fighting that survived every other fix.
 *
 * The equivalent under a log buffer is to bias `vFragDepth` itself. Because the stored
 * depth is a logarithm, scaling that value by a constant shifts the result by a constant
 * *number of depth-buffer units at every distance* — which is the behaviour polygon offset
 * has to approximate with its slope-scaled term, and here it comes out exactly.
 *
 * The existing `polygonOffset` settings are deliberately left in place alongside these:
 * they are correct and would take over unchanged if the log buffer were ever switched off.
 */
import * as THREE from 'three';

/**
 * Bias values, as a fraction of `vFragDepth`. Positive pulls a surface toward the camera
 * so it wins the depth test against whatever it is coplanar with.
 *
 * The scale: with far = 2500 the stored depth is `log2(1 + w) * 0.0886`, so a relative
 * change `b` moves it by about `0.128 * b`, and one unit of a 24-bit depth buffer is
 * 6e-8. `SURFACE` is therefore worth roughly 100 depth units — far more than the couple
 * of units of numerical noise that makes two coplanar surfaces flicker, and still small
 * enough that nothing visibly floats.
 */
export const DEPTH_BIAS = {
  /** Flat layers stacked on the ground: roads over terrain, water over the ground plane. */
  surface: 5e-5,
  /** A wall over the roof and neighbouring walls it shares an edge with. */
  facade: 2e-5,
  /** Decals that belong *on* a surface — paint, scuffs, the inspection highlight. */
  decal: 1e-4,
  /** Pushes a surface back instead: the plain building box, so anything drawn on the
   * same footprint wins over it. */
  behind: -4e-5,
} as const;

const VERTEX_HOOK = '#include <logdepthbuf_vertex>';

/**
 * The `logdepthbuf_vertex` include followed by the bias. Guarded on the same define
 * three.js uses, so a build with the log buffer off compiles this away and falls back to
 * the material's own `polygonOffset`.
 */
export function logDepthBiasChunk(bias: number): string {
  return `${VERTEX_HOOK}
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    vFragDepth *= ${(1 - bias).toFixed(8)};
  #endif`;
}

/**
 * Rewrites a shader source of ours to carry the bias. The source has to already include
 * `logdepthbuf_vertex`; without it there is no depth for the bias to apply to and this
 * would be a silent no-op, so it throws instead.
 */
export function withLogDepthBias(vertexShader: string, bias: number): string {
  if (!vertexShader.includes(VERTEX_HOOK)) {
    throw new Error('withLogDepthBias needs a vertex shader that includes logdepthbuf_vertex');
  }
  return vertexShader.replace(VERTEX_HOOK, logDepthBiasChunk(bias));
}

/**
 * Same thing for a built-in material, whose shader we only get to touch on compile.
 *
 * `customProgramCacheKey` is not optional here: two MeshStandardMaterials that differ
 * only by what `onBeforeCompile` did to them would otherwise share one compiled program,
 * and whichever compiled first would decide the bias for both.
 */
export function applyLogDepthBias<T extends THREE.Material>(material: T, bias: number): T {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = withLogDepthBias(shader.vertexShader, bias);
  };
  material.customProgramCacheKey = () => `logDepthBias:${bias}`;
  return material;
}
